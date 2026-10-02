// ------------------------------------------------------------------------
// 名称：sqlite-asset-repository.ts
// 说明：资产与资产文件数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：列表只读取缩略图；描述字段以 JSON 保存在 attributes_json；新增与修改在事务内同时写资产与文件。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import {
  AssetContent,
  AssetFileRecord,
  AssetFileRole,
  AssetInput,
  AssetKind,
  AssetListItem,
  AssetRecord,
  AssetUsage,
  AssetUsageSummary,
  NewAssetFile
} from '../../domain/models/asset';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { runInTransaction } from './transaction';

/** assets 表的一行。 */
interface AssetRow {
  readonly id: number;
  readonly project_id: number;
  readonly kind: AssetKind;
  readonly name: string;
  readonly source_entity_id: number | null;
  readonly attributes_json: string;
  readonly composition: string;
  readonly style: string | null;
  readonly background: string;
  readonly reference_aspect_ratio: string | null;
  readonly extra_requirements: string;
  readonly prompt_zh: string;
  readonly prompt_en: string;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 列表查询的一行：资产加统计与缩略图。 */
interface AssetListRow extends AssetRow {
  readonly file_count: number;
  readonly duration_seconds: number | null;
  readonly episode_count: number;
  readonly thumb_mime: string | null;
  readonly thumb_content: Uint8Array | null;
}

/** asset_files 表的一行（含内容）。 */
interface AssetFileRow {
  readonly id: number;
  readonly asset_id: number;
  readonly role: AssetFileRole;
  readonly file_name: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_seconds: number | null;
  readonly content: Uint8Array;
  readonly sort_order: number;
}

function toRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    name: row.name,
    sourceEntityId: row.source_entity_id,
    attributes: JSON.parse(row.attributes_json) as Record<string, string>,
    composition: row.composition,
    style: row.style,
    background: row.background,
    referenceAspectRatio: row.reference_aspect_ratio,
    extraRequirements: row.extra_requirements,
    promptZh: row.prompt_zh,
    promptEn: row.prompt_en,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** 基于 SQLite 的资产仓库。 */
export class SqliteAssetRepository implements AssetRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(kind: AssetKind): AssetListItem[] {
    const rows = this.database
      .prepare(
        `SELECT a.*,
           (SELECT COUNT(*) FROM asset_files f WHERE f.asset_id = a.id AND f.role = 'reference') AS file_count,
           (SELECT f.duration_seconds FROM asset_files f WHERE f.asset_id = a.id AND f.role = 'reference'
             ORDER BY f.sort_order, f.id LIMIT 1) AS duration_seconds,
           (SELECT COUNT(DISTINCT b.episode_id) FROM entity_bindings b WHERE b.asset_id = a.id) AS episode_count,
           (SELECT t.mime FROM asset_files t WHERE t.asset_id = a.id AND t.role = 'thumbnail'
             ORDER BY t.sort_order, t.id LIMIT 1) AS thumb_mime,
           (SELECT t.content FROM asset_files t WHERE t.asset_id = a.id AND t.role = 'thumbnail'
             ORDER BY t.sort_order, t.id LIMIT 1) AS thumb_content
         FROM assets a WHERE a.kind = ? ORDER BY a.updated_at DESC, a.id DESC`
      )
      .all(kind) as unknown as AssetListRow[];
    return rows.map((row) => ({
      ...toRecord(row),
      thumbnail:
        row.thumb_mime === null || row.thumb_content === null
          ? null
          : { mime: row.thumb_mime, data: Buffer.from(row.thumb_content).toString('base64') },
      fileCount: row.file_count,
      durationSeconds: row.duration_seconds,
      episodeCount: row.episode_count
    }));
  }

  findById(id: number): AssetRecord | undefined {
    const row = this.database.prepare('SELECT * FROM assets WHERE id = ?').get(id) as unknown as AssetRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  findByName(projectId: number, kind: AssetKind, name: string): AssetRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM assets WHERE project_id = ? AND kind = ? AND name = ?')
      .get(projectId, kind, name) as unknown as AssetRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  listProjectAssets(projectId: number): Array<{ readonly id: number; readonly kind: AssetKind; readonly name: string }> {
    return this.database
      .prepare('SELECT id, kind, name FROM assets WHERE project_id = ? ORDER BY id')
      .all(projectId) as unknown as Array<{ id: number; kind: AssetKind; name: string }>;
  }

  listReferenceFiles(assetId: number): AssetFileRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, asset_id, role, file_name, mime, width, height, duration_seconds, content, sort_order
           FROM asset_files WHERE asset_id = ? AND role = 'reference' ORDER BY sort_order, id`
      )
      .all(assetId) as unknown as AssetFileRow[];
    return rows.map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      role: row.role,
      fileName: row.file_name,
      mime: row.mime,
      width: row.width,
      height: row.height,
      durationSeconds: row.duration_seconds,
      content: Buffer.from(row.content),
      sortOrder: row.sort_order
    }));
  }

  insert(input: AssetInput, files: readonly NewAssetFile[], timestamp: string): number {
    return runInTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `INSERT INTO assets (project_id, kind, name, source_entity_id, attributes_json, composition, style, background,
             reference_aspect_ratio, extra_requirements, prompt_zh, prompt_en, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.projectId,
          input.kind,
          input.name,
          input.sourceEntityId,
          JSON.stringify(input.attributes),
          input.composition,
          input.style,
          input.background,
          input.referenceAspectRatio,
          input.extraRequirements,
          input.promptZh,
          input.promptEn,
          timestamp,
          timestamp
        );
      const assetId = Number(result.lastInsertRowid);
      this.insertFiles(assetId, files, timestamp);
      return assetId;
    });
  }

  update(id: number, content: AssetContent, files: readonly NewAssetFile[], timestamp: string): boolean {
    return runInTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE assets SET name = ?, attributes_json = ?, composition = ?, style = ?, background = ?,
             reference_aspect_ratio = ?, extra_requirements = ?, prompt_zh = ?, prompt_en = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          content.name,
          JSON.stringify(content.attributes),
          content.composition,
          content.style,
          content.background,
          content.referenceAspectRatio,
          content.extraRequirements,
          content.promptZh,
          content.promptEn,
          timestamp,
          id
        );
      if (Number(result.changes) === 0) {
        return false;
      }
      this.database.prepare('DELETE FROM asset_files WHERE asset_id = ?').run(id);
      this.insertFiles(id, files, timestamp);
      return true;
    });
  }

  remove(id: number): boolean {
    const result = this.database.prepare('DELETE FROM assets WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  getUsage(id: number): AssetUsageSummary {
    const rows = this.database
      .prepare(
        `SELECT w.name AS work_name, e.seq AS episode_seq, e.title AS episode_title, se.name AS entity_name
           FROM entity_bindings b
           JOIN episodes e ON e.id = b.episode_id
           JOIN works w ON w.id = e.work_id
           JOIN script_entities se ON se.id = b.entity_id
          WHERE b.asset_id = ?
          ORDER BY w.name, e.seq, se.name`
      )
      .all(id) as unknown as Array<{ work_name: string; episode_seq: number; episode_title: string; entity_name: string }>;
    const sounds = this.database.prepare('SELECT COUNT(*) AS total FROM shot_sounds WHERE audio_asset_id = ?').get(id) as unknown as {
      total: number;
    };
    const bindings: AssetUsage[] = rows.map((row) => ({
      workName: row.work_name,
      episodeSeq: row.episode_seq,
      episodeTitle: row.episode_title,
      entityName: row.entity_name
    }));
    return { bindings, soundReferences: sounds.total };
  }

  /** 写入资产的文件；调用方负责事务。 */
  private insertFiles(assetId: number, files: readonly NewAssetFile[], timestamp: string): void {
    const insert = this.database.prepare(
      `INSERT INTO asset_files (asset_id, role, file_name, mime, width, height, duration_seconds, size_bytes, content, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const file of files) {
      insert.run(
        assetId,
        file.role,
        file.fileName,
        file.mime,
        file.width,
        file.height,
        file.durationSeconds,
        file.content.length,
        file.content,
        file.sortOrder,
        timestamp
      );
    }
  }
}
