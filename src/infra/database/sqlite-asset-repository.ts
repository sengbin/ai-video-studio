// ------------------------------------------------------------------------
// 名称：sqlite-asset-repository.ts
// 说明：资产与资产文件数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：文件内容保存在磁盘（AssetFileStore），表里只记路径；列表只读取缩略图；描述字段以 JSON 保存在 attributes_json；新增与修改在事务内同时写资产与文件记录，删除记录后再清理不再被引用的磁盘文件；上传与生成两种来源的文件各自保留，读取只取资产当前使用来源的文件。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import {
  AssetContent,
  AssetFileRecord,
  AssetFileRole,
  AssetFileSource,
  AssetGenerationSummary,
  AssetInput,
  AssetKind,
  AssetListItem,
  AssetRecord,
  AssetSoundUsage,
  AssetUsage,
  AssetUsageSummary,
  NewAssetFile,
  PromptStatus
} from '../../domain/models/asset';
import { AssetFileStore } from '../../domain/ports/asset-file-store';
import { AssetRepository, GeneratedPrompts } from '../../domain/ports/asset-repository';
import { AssetRevisionUpdate, PromptRevisionUpdate } from '../../domain/rules/asset-generation-rules';
import { collectAssetFilePaths, removeUnreferencedFiles } from './asset-file-cleanup';
import { runInTransaction } from './transaction';

/** assets 表的一行。 */
interface AssetRow {
  readonly id: number;
  readonly kind: AssetKind;
  readonly name: string;
  readonly source_entity_id: number | null;
  readonly category_id: number | null;
  readonly attributes_json: string;
  readonly composition: string;
  readonly style: string | null;
  readonly background: string;
  readonly reference_aspect_ratio: string | null;
  readonly extra_requirements: string;
  readonly prompt_zh: string;
  readonly prompt_en: string;
  readonly content_revision: number;
  readonly prompt_revision: number;
  readonly prompt_content_revision: number;
  readonly prompt_status: PromptStatus;
  readonly prompt_error: string | null;
  readonly adopted_version_id: number | null;
  readonly file_source: AssetFileSource;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 列表查询的一行：资产加统计与缩略图。 */
interface AssetListRow extends AssetRow {
  readonly file_count: number;
  readonly upload_file_count: number;
  readonly duration_seconds: number | null;
  readonly episode_count: number;
  readonly thumb_mime: string | null;
  readonly thumb_path: string | null;
  readonly version_count: number;
  readonly latest_json: string | null;
  readonly latest_succeeded: number | null;
  readonly adopted_version: number | null;
}

/** asset_files 表的一行（内容在磁盘文件里，路径见 file_path）。 */
interface AssetFileRow {
  readonly id: number;
  readonly asset_id: number;
  readonly role: AssetFileRole;
  readonly file_name: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_seconds: number | null;
  readonly file_path: string;
  readonly sort_order: number;
}

function toRecord(row: AssetRow): AssetRecord {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    sourceEntityId: row.source_entity_id,
    categoryId: row.category_id,
    attributes: JSON.parse(row.attributes_json) as Record<string, string>,
    composition: row.composition,
    style: row.style,
    background: row.background,
    referenceAspectRatio: row.reference_aspect_ratio,
    extraRequirements: row.extra_requirements,
    promptZh: row.prompt_zh,
    promptEn: row.prompt_en,
    contentRevision: row.content_revision,
    promptRevision: row.prompt_revision,
    promptContentRevision: row.prompt_content_revision,
    promptStatus: row.prompt_status,
    promptError: row.prompt_error,
    adoptedVersionId: row.adopted_version_id,
    fileSource: row.file_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** 把列表查询的版本统计列转换为生成摘要。 */
function toGenerationSummary(row: AssetListRow): AssetGenerationSummary {
  return {
    versionCount: row.version_count,
    latest: row.latest_json === null ? null : (JSON.parse(row.latest_json) as AssetGenerationSummary['latest']),
    latestSucceeded: row.latest_succeeded,
    adoptedVersion: row.adopted_version
  };
}

/** 基于 SQLite 的资产仓库。 */
export class SqliteAssetRepository implements AssetRepository {
  /**
   * @param database 数据库连接。
   * @param files 资产文件内容的存储。
   */
  constructor(
    private readonly database: DatabaseSync,
    private readonly files: AssetFileStore
  ) {}

  list(kind: AssetKind): AssetListItem[] {
    const rows = this.database
      .prepare(
        `SELECT a.*,
           (SELECT COUNT(*) FROM asset_files f WHERE f.asset_id = a.id AND f.role = 'reference' AND f.source = a.file_source) AS file_count,
           (SELECT COUNT(*) FROM asset_files f WHERE f.asset_id = a.id AND f.role = 'reference' AND f.source = 'upload') AS upload_file_count,
           (SELECT f.duration_seconds FROM asset_files f WHERE f.asset_id = a.id AND f.role = 'reference' AND f.source = a.file_source
             ORDER BY f.sort_order, f.id LIMIT 1) AS duration_seconds,
           (SELECT COUNT(*) FROM episodes e
             WHERE EXISTS (SELECT 1 FROM entity_bindings b WHERE b.episode_id = e.id AND b.asset_id = a.id)
                OR EXISTS (SELECT 1 FROM shot_sounds s
                             JOIN shots sh ON sh.id = s.shot_id
                             JOIN storyboard_scripts ss ON ss.id = sh.storyboard_script_id
                            WHERE ss.episode_id = e.id AND s.audio_asset_id = a.id)) AS episode_count,
           (SELECT t.mime FROM asset_files t WHERE t.asset_id = a.id AND t.role = 'thumbnail' AND t.source = a.file_source
             ORDER BY t.sort_order, t.id LIMIT 1) AS thumb_mime,
           (SELECT t.file_path FROM asset_files t WHERE t.asset_id = a.id AND t.role = 'thumbnail' AND t.source = a.file_source
             ORDER BY t.sort_order, t.id LIMIT 1) AS thumb_path,
           (SELECT COUNT(*) FROM asset_versions v WHERE v.asset_id = a.id) AS version_count,
           (SELECT json_object('id', v.id, 'version', v.version, 'status', v.status, 'contentRevision', v.content_revision,
                               'promptRevision', v.prompt_revision, 'errorMessage', v.error_message)
              FROM asset_versions v WHERE v.asset_id = a.id AND v.status <> 'canceled'
             ORDER BY v.version DESC LIMIT 1) AS latest_json,
           (SELECT MAX(v.version) FROM asset_versions v WHERE v.asset_id = a.id AND v.status = 'succeeded') AS latest_succeeded,
           (SELECT v.version FROM asset_versions v WHERE v.id = a.adopted_version_id) AS adopted_version
         FROM assets a WHERE a.kind = ? ORDER BY a.updated_at DESC, a.id DESC`
      )
      .all(kind) as unknown as AssetListRow[];
    return rows.map((row) => ({
      ...toRecord(row),
      thumbnail:
        row.thumb_mime === null || row.thumb_path === null
          ? null
          : { mime: row.thumb_mime, data: this.files.read(row.thumb_path).toString('base64') },
      fileCount: row.file_count,
      uploadFileCount: row.upload_file_count,
      durationSeconds: row.duration_seconds,
      episodeCount: row.episode_count,
      generation: toGenerationSummary(row)
    }));
  }

  findById(id: number): AssetRecord | undefined {
    const row = this.database.prepare('SELECT * FROM assets WHERE id = ?').get(id) as unknown as AssetRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  findByName(kind: AssetKind, name: string): AssetRecord | undefined {
    const row = this.database
      .prepare('SELECT * FROM assets WHERE kind = ? AND name = ?')
      .get(kind, name) as unknown as AssetRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  listNames(): Array<{ readonly id: number; readonly kind: AssetKind; readonly name: string }> {
    return this.database
      .prepare('SELECT id, kind, name FROM assets ORDER BY id')
      .all() as unknown as Array<{ id: number; kind: AssetKind; name: string }>;
  }

  listReferenceFiles(assetId: number): AssetFileRecord[] {
    return this.listActiveFiles(assetId, 'reference');
  }

  listThumbnailFiles(assetId: number): AssetFileRecord[] {
    return this.listActiveFiles(assetId, 'thumbnail');
  }

  listUploadFiles(assetId: number): AssetFileRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, asset_id, role, file_name, mime, width, height, duration_seconds, file_path, sort_order
           FROM asset_files WHERE asset_id = ? AND role = 'reference' AND source = 'upload' ORDER BY sort_order, id`
      )
      .all(assetId) as unknown as AssetFileRow[];
    return rows.map((row) => this.toFileRecord(row));
  }

  countReferenceFiles(assetId: number): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM asset_files f JOIN assets a ON a.id = f.asset_id
          WHERE f.asset_id = ? AND f.role = 'reference' AND f.source = a.file_source`
      )
      .get(assetId) as unknown as { total: number };
    return row.total;
  }

  countFiles(assetId: number, source: AssetFileSource): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS total FROM asset_files WHERE asset_id = ? AND role = 'reference' AND source = ?")
      .get(assetId, source) as unknown as { total: number };
    return row.total;
  }

  /** 读取资产当前使用来源的某种用途的文件（含内容）。 */
  private listActiveFiles(assetId: number, role: AssetFileRole): AssetFileRecord[] {
    const rows = this.database
      .prepare(
        `SELECT f.id, f.asset_id, f.role, f.file_name, f.mime, f.width, f.height, f.duration_seconds, f.file_path, f.sort_order
           FROM asset_files f JOIN assets a ON a.id = f.asset_id
          WHERE f.asset_id = ? AND f.role = ? AND f.source = a.file_source ORDER BY f.sort_order, f.id`
      )
      .all(assetId, role) as unknown as AssetFileRow[];
    return rows.map((row) => this.toFileRecord(row));
  }

  /** 把一行文件记录连同磁盘上的内容转换为资产文件。 */
  private toFileRecord(row: AssetFileRow): AssetFileRecord {
    return {
      id: row.id,
      assetId: row.asset_id,
      role: row.role,
      fileName: row.file_name,
      mime: row.mime,
      width: row.width,
      height: row.height,
      durationSeconds: row.duration_seconds,
      content: this.files.read(row.file_path),
      sortOrder: row.sort_order
    };
  }

  insert(input: AssetInput, files: readonly NewAssetFile[], timestamp: string): number {
    return runInTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `INSERT INTO assets (kind, name, source_entity_id, category_id, attributes_json, composition, style, background,
             reference_aspect_ratio, extra_requirements, prompt_zh, prompt_en, prompt_revision, prompt_content_revision,
             file_source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.kind,
          input.name,
          input.sourceEntityId,
          input.categoryId,
          JSON.stringify(input.attributes),
          input.composition,
          input.style,
          input.background,
          input.referenceAspectRatio,
          input.extraRequirements,
          input.promptZh,
          input.promptEn,
          input.promptZh !== '' || input.promptEn !== '' ? 1 : 0,
          input.promptZh !== '' || input.promptEn !== '' ? 1 : 0,
          input.fileSource,
          timestamp,
          timestamp
        );
      const assetId = Number(result.lastInsertRowid);
      this.insertFiles(assetId, files, timestamp);
      return assetId;
    });
  }

  update(
    id: number,
    content: AssetContent,
    categoryId: number | null,
    files: readonly NewAssetFile[] | null,
    fileSource: AssetFileSource,
    timestamp: string,
    revision: AssetRevisionUpdate
  ): boolean {
    let replacedPaths: string[] = [];
    const updated = runInTransaction(this.database, () => {
      const result = this.database
        .prepare(
          `UPDATE assets SET name = ?, category_id = ?, attributes_json = ?, composition = ?, style = ?, background = ?,
             reference_aspect_ratio = ?, extra_requirements = ?, prompt_zh = ?, prompt_en = ?,
             content_revision = ?, prompt_revision = ?, prompt_content_revision = ?, file_source = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          content.name,
          categoryId,
          JSON.stringify(content.attributes),
          content.composition,
          content.style,
          content.background,
          content.referenceAspectRatio,
          content.extraRequirements,
          content.promptZh,
          content.promptEn,
          revision.contentRevision,
          revision.promptRevision,
          revision.promptContentRevision,
          fileSource,
          timestamp,
          id
        );
      if (Number(result.changes) === 0) {
        return false;
      }
      // 只替换上传来源的文件；生成来源的文件由采用版本维护，不受表单保存影响。
      if (files !== null) {
        replacedPaths = this.listUploadPaths(id);
        this.database.prepare("DELETE FROM asset_files WHERE asset_id = ? AND source = 'upload'").run(id);
        this.insertFiles(id, files, timestamp);
      }
      return true;
    });
    removeUnreferencedFiles(this.database, this.files, replacedPaths);
    return updated;
  }

  setFileSource(id: number, source: AssetFileSource, timestamp: string): boolean {
    const result = this.database.prepare('UPDATE assets SET file_source = ?, updated_at = ? WHERE id = ?').run(source, timestamp, id);
    return Number(result.changes) > 0;
  }

  updatePrompts(id: number, prompts: GeneratedPrompts, revision: PromptRevisionUpdate, timestamp: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE assets SET prompt_zh = ?, prompt_en = ?, prompt_revision = ?, prompt_content_revision = ?,
           prompt_status = 'none', prompt_error = NULL, updated_at = ?
         WHERE id = ? AND prompt_status <> 'running'`
      )
      .run(prompts.promptZh, prompts.promptEn, revision.promptRevision, revision.promptContentRevision, timestamp, id);
    return Number(result.changes) > 0;
  }

  beginPrompt(id: number, timestamp: string): boolean {
    const result = this.database
      .prepare("UPDATE assets SET prompt_status = 'running', prompt_error = NULL, updated_at = ? WHERE id = ? AND prompt_status <> 'running'")
      .run(timestamp, id);
    return Number(result.changes) > 0;
  }

  finishPrompt(id: number, prompts: GeneratedPrompts, basedOnContentRevision: number, timestamp: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE assets SET prompt_zh = ?, prompt_en = ?, prompt_revision = prompt_revision + 1, prompt_content_revision = ?,
           prompt_status = 'succeeded', prompt_error = NULL, updated_at = ?
         WHERE id = ? AND prompt_status = 'running'`
      )
      .run(prompts.promptZh, prompts.promptEn, basedOnContentRevision, timestamp, id);
    return Number(result.changes) > 0;
  }

  endPrompt(id: number, status: 'failed' | 'canceled', error: string | null, timestamp: string): boolean {
    const result = this.database
      .prepare("UPDATE assets SET prompt_status = ?, prompt_error = ?, updated_at = ? WHERE id = ? AND prompt_status = 'running'")
      .run(status, error, timestamp, id);
    return Number(result.changes) > 0;
  }

  listPromptRunning(): number[] {
    const rows = this.database.prepare("SELECT id FROM assets WHERE prompt_status = 'running' ORDER BY id").all() as unknown as Array<{ id: number }>;
    return rows.map((row) => row.id);
  }

  remove(id: number): boolean {
    // 删除前先记下引用的文件路径（删除后无法再查），提交后清理不再被引用的磁盘文件。
    const paths = collectAssetFilePaths(this.database, id);
    const result = this.database.prepare('DELETE FROM assets WHERE id = ?').run(id);
    removeUnreferencedFiles(this.database, this.files, paths);
    return Number(result.changes) > 0;
  }

  getUsage(id: number): AssetUsageSummary {
    const rows = this.database
      .prepare(
        `SELECT w.name AS work_name, e.seq AS episode_seq, e.title AS episode_title, se.name AS entity_name, b.purpose
           FROM entity_bindings b
           JOIN episodes e ON e.id = b.episode_id
           JOIN works w ON w.id = e.work_id
           JOIN script_entities se ON se.id = b.entity_id
          WHERE b.asset_id = ?
          ORDER BY w.name, e.seq, se.name`
      )
      .all(id) as unknown as Array<{ work_name: string; episode_seq: number; episode_title: string; entity_name: string; purpose: string }>;
    // 镜头声音经 镜头 → 分镜脚本 找到所在的集；同一集可能有多条，按集汇总。
    const soundRows = this.database
      .prepare(
        `SELECT w.name AS work_name, e.seq AS episode_seq, e.title AS episode_title, COUNT(*) AS sound_count
           FROM shot_sounds s
           JOIN shots sh ON sh.id = s.shot_id
           JOIN storyboard_scripts ss ON ss.id = sh.storyboard_script_id
           JOIN episodes e ON e.id = ss.episode_id
           JOIN works w ON w.id = e.work_id
          WHERE s.audio_asset_id = ?
          GROUP BY e.id
          ORDER BY w.name, e.seq`
      )
      .all(id) as unknown as Array<{ work_name: string; episode_seq: number; episode_title: string; sound_count: number }>;
    const bindings: AssetUsage[] = rows.map((row) => ({
      workName: row.work_name,
      episodeSeq: row.episode_seq,
      episodeTitle: row.episode_title,
      entityName: row.entity_name
    }));
    const soundEpisodes: AssetSoundUsage[] = soundRows.map((row) => ({
      workName: row.work_name,
      episodeSeq: row.episode_seq,
      episodeTitle: row.episode_title,
      soundCount: row.sound_count
    }));
    return {
      bindings,
      soundReferences: soundEpisodes.reduce((total, item) => total + item.soundCount, 0),
      soundEpisodes,
      voiceBindingCount: rows.filter((row) => row.purpose === 'voice').length
    };
  }

  /** 资产上传来源的文件路径（含缩略图）。 */
  private listUploadPaths(assetId: number): string[] {
    const rows = this.database.prepare("SELECT file_path FROM asset_files WHERE asset_id = ? AND source = 'upload'").all(assetId) as unknown as Array<{
      file_path: string;
    }>;
    return rows.map((row) => row.file_path);
  }

  /** 把内容写入磁盘并登记为资产的上传文件；调用方负责事务。 */
  private insertFiles(assetId: number, files: readonly NewAssetFile[], timestamp: string): void {
    const insert = this.database.prepare(
      `INSERT INTO asset_files (asset_id, role, source, file_name, mime, width, height, duration_seconds, size_bytes, file_path, sort_order, created_at)
       VALUES (?, ?, 'upload', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        this.files.write(file.content, file.mime),
        file.sortOrder,
        timestamp
      );
    }
  }
}
