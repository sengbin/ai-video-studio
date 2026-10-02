// ------------------------------------------------------------------------
// 名称：sqlite-asset-version-repository.ts
// 说明：资产生成版本数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：状态流转用带前置状态的 UPDATE 实现，已被取消或结束的版本不会被覆盖；结果文件写入与状态变为成功在同一事务内；采用时整体替换资产的参考文件。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { ProviderFailure } from '../../domain/errors';
import {
  AssetVersionFailure,
  AssetVersionFile,
  AssetVersionFileContent,
  AssetVersionFileRole,
  AssetVersionRecord,
  AssetVersionSnapshot,
  AssetVersionStatus,
  NewAssetVersion,
  NewAssetVersionFile
} from '../../domain/models/asset-version';
import { AssetVersionRepository, VersionThumbnailUpdate } from '../../domain/ports/asset-version-repository';
import { runInTransaction } from './transaction';

/** asset_versions 加模型名称的一行。 */
interface VersionRow {
  readonly id: number;
  readonly asset_id: number;
  readonly version: number;
  readonly model_id: number;
  readonly model_name: string;
  readonly status: AssetVersionStatus;
  readonly request_snapshot_json: string;
  readonly content_revision: number;
  readonly prompt_revision: number;
  readonly remote_job_id: string | null;
  readonly error_category: ProviderFailure | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly attempt: number;
  readonly created_at: string;
  readonly submitted_at: string | null;
  readonly finished_at: string | null;
}

/** asset_version_files 的一行（可带内容）。 */
interface FileRow {
  readonly id: number;
  readonly version_id: number;
  readonly role: AssetVersionFileRole;
  readonly file_name: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_seconds: number | null;
  readonly size_bytes: number;
  readonly sort_order: number;
  readonly is_adopted: number;
  readonly content?: Uint8Array;
}

const VERSION_SELECT = `SELECT v.*, m.display_name AS model_name
  FROM asset_versions v JOIN models m ON m.id = v.model_id`;

const FILE_COLUMNS = 'id, version_id, role, file_name, mime, width, height, duration_seconds, size_bytes, sort_order, is_adopted';

function toVersion(row: VersionRow): AssetVersionRecord {
  return {
    id: row.id,
    assetId: row.asset_id,
    version: row.version,
    modelId: row.model_id,
    modelName: row.model_name,
    status: row.status,
    snapshot: JSON.parse(row.request_snapshot_json) as AssetVersionSnapshot,
    contentRevision: row.content_revision,
    promptRevision: row.prompt_revision,
    remoteJobId: row.remote_job_id,
    errorCategory: row.error_category,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    attempt: row.attempt,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    finishedAt: row.finished_at
  };
}

function toFile(row: FileRow): AssetVersionFile {
  return {
    id: row.id,
    versionId: row.version_id,
    role: row.role,
    fileName: row.file_name,
    mime: row.mime,
    width: row.width,
    height: row.height,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    sortOrder: row.sort_order,
    isAdopted: row.is_adopted === 1
  };
}

function toFileContent(row: FileRow): AssetVersionFileContent {
  return { ...toFile(row), content: Buffer.from(row.content ?? new Uint8Array()) };
}

/** 基于 SQLite 的资产版本仓库。 */
export class SqliteAssetVersionRepository implements AssetVersionRepository {
  constructor(private readonly database: DatabaseSync) {}

  createVersion(input: NewAssetVersion, timestamp: string): number {
    return runInTransaction(this.database, () => {
      const next = this.database
        .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS next FROM asset_versions WHERE asset_id = ?')
        .get(input.assetId) as unknown as { next: number };
      const result = this.database
        .prepare(
          `INSERT INTO asset_versions (asset_id, version, model_id, status, request_snapshot_json, content_revision, prompt_revision, created_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
        )
        .run(input.assetId, next.next, input.modelId, JSON.stringify(input.snapshot), input.contentRevision, input.promptRevision, timestamp);
      return Number(result.lastInsertRowid);
    });
  }

  findVersion(id: number): AssetVersionRecord | undefined {
    const row = this.database.prepare(`${VERSION_SELECT} WHERE v.id = ?`).get(id) as unknown as VersionRow | undefined;
    return row === undefined ? undefined : toVersion(row);
  }

  listVersions(assetId: number): AssetVersionRecord[] {
    const rows = this.database
      .prepare(`${VERSION_SELECT} WHERE v.asset_id = ? ORDER BY v.version DESC`)
      .all(assetId) as unknown as VersionRow[];
    return rows.map(toVersion);
  }

  listByStatus(statuses: readonly AssetVersionStatus[]): AssetVersionRecord[] {
    const marks = statuses.map(() => '?').join(', ');
    const rows = this.database
      .prepare(`${VERSION_SELECT} WHERE v.status IN (${marks}) ORDER BY v.id`)
      .all(...statuses) as unknown as VersionRow[];
    return rows.map(toVersion);
  }

  markSubmitted(id: number, remoteJobId: string, timestamp: string): boolean {
    return this.changed(
      this.database
        .prepare("UPDATE asset_versions SET status = 'running', remote_job_id = ?, submitted_at = ? WHERE id = ? AND status = 'queued'")
        .run(remoteJobId, timestamp, id)
    );
  }

  markFailed(id: number, failure: AssetVersionFailure, timestamp: string): boolean {
    return this.changed(
      this.database
        .prepare(
          `UPDATE asset_versions SET status = 'failed', error_category = ?, error_code = ?, error_message = ?, finished_at = ?
           WHERE id = ? AND status IN ('queued', 'running')`
        )
        .run(failure.category, failure.code, failure.message, timestamp, id)
    );
  }

  markCanceled(id: number, timestamp: string): boolean {
    return this.changed(
      this.database
        .prepare("UPDATE asset_versions SET status = 'canceled', finished_at = ? WHERE id = ? AND status IN ('queued', 'running')")
        .run(timestamp, id)
    );
  }

  markSucceeded(id: number, files: readonly NewAssetVersionFile[], timestamp: string): boolean {
    return runInTransaction(this.database, () => {
      const updated = this.changed(
        this.database
          .prepare("UPDATE asset_versions SET status = 'succeeded', finished_at = ? WHERE id = ? AND status = 'running'")
          .run(timestamp, id)
      );
      if (updated) {
        this.insertFiles(id, files, timestamp);
      }
      return updated;
    });
  }

  restart(id: number): boolean {
    return this.changed(
      this.database
        .prepare(
          `UPDATE asset_versions SET status = 'queued', attempt = attempt + 1, remote_job_id = NULL, error_category = NULL,
             error_code = NULL, error_message = NULL, submitted_at = NULL, finished_at = NULL
           WHERE id = ? AND status IN ('failed', 'canceled')`
        )
        .run(id)
    );
  }

  listFiles(versionId: number): AssetVersionFile[] {
    const rows = this.database
      .prepare(`SELECT ${FILE_COLUMNS} FROM asset_version_files WHERE version_id = ? ORDER BY role DESC, sort_order, id`)
      .all(versionId) as unknown as FileRow[];
    return rows.map(toFile);
  }

  getFile(fileId: number): AssetVersionFileContent | undefined {
    const row = this.database
      .prepare(`SELECT ${FILE_COLUMNS}, content FROM asset_version_files WHERE id = ?`)
      .get(fileId) as unknown as FileRow | undefined;
    return row === undefined ? undefined : toFileContent(row);
  }

  listFilesWithContent(versionId: number, role: AssetVersionFileRole): AssetVersionFileContent[] {
    const rows = this.database
      .prepare(`SELECT ${FILE_COLUMNS}, content FROM asset_version_files WHERE version_id = ? AND role = ? ORDER BY sort_order, id`)
      .all(versionId, role) as unknown as FileRow[];
    return rows.map(toFileContent);
  }

  saveThumbnails(versionId: number, updates: readonly VersionThumbnailUpdate[], timestamp: string): boolean {
    return runInTransaction(this.database, () => {
      const version = this.database.prepare('SELECT id FROM asset_versions WHERE id = ?').get(versionId);
      if (version === undefined) {
        return false;
      }
      for (const update of updates) {
        this.database
          .prepare("UPDATE asset_version_files SET width = ?, height = ? WHERE version_id = ? AND role = 'result' AND sort_order = ?")
          .run(update.width, update.height, versionId, update.sortOrder);
        this.database
          .prepare("DELETE FROM asset_version_files WHERE version_id = ? AND role = 'thumbnail' AND sort_order = ?")
          .run(versionId, update.sortOrder);
        this.insertFiles(versionId, [update.thumbnail], timestamp);
      }
      return true;
    });
  }

  deleteVersion(id: number): boolean {
    return this.changed(this.database.prepare('DELETE FROM asset_versions WHERE id = ?').run(id));
  }

  adopt(assetId: number, versionId: number, fileIds: readonly number[], timestamp: string): void {
    runInTransaction(this.database, () => {
      const chosen = fileIds.map((id) => {
        const row = this.database
          .prepare(`SELECT ${FILE_COLUMNS}, content FROM asset_version_files WHERE id = ? AND version_id = ? AND role = 'result'`)
          .get(id, versionId) as unknown as FileRow | undefined;
        if (row === undefined) {
          throw new Error(`版本文件 ${id} 不存在。`);
        }
        return row;
      });
      this.database.prepare('DELETE FROM asset_files WHERE asset_id = ?').run(assetId);
      this.database
        .prepare('UPDATE asset_version_files SET is_adopted = 0 WHERE version_id IN (SELECT id FROM asset_versions WHERE asset_id = ?)')
        .run(assetId);
      const insert = this.database.prepare(
        `INSERT INTO asset_files (asset_id, role, file_name, mime, width, height, duration_seconds, size_bytes, content, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      chosen.forEach((row, index) => {
        insert.run(assetId, 'reference', row.file_name, row.mime, row.width, row.height, row.duration_seconds, row.size_bytes, row.content ?? new Uint8Array(), index, timestamp);
        const thumbnail = this.database
          .prepare(`SELECT ${FILE_COLUMNS}, content FROM asset_version_files WHERE version_id = ? AND role = 'thumbnail' AND sort_order = ?`)
          .get(versionId, row.sort_order) as unknown as FileRow | undefined;
        if (thumbnail !== undefined) {
          insert.run(assetId, 'thumbnail', thumbnail.file_name, thumbnail.mime, thumbnail.width, thumbnail.height, null, thumbnail.size_bytes, thumbnail.content ?? new Uint8Array(), index, timestamp);
        }
        this.database.prepare('UPDATE asset_version_files SET is_adopted = 1 WHERE id = ?').run(row.id);
      });
      this.database.prepare('UPDATE assets SET adopted_version_id = ?, updated_at = ? WHERE id = ?').run(versionId, timestamp, assetId);
    });
  }

  private insertFiles(versionId: number, files: readonly NewAssetVersionFile[], timestamp: string): void {
    const insert = this.database.prepare(
      `INSERT INTO asset_version_files (version_id, role, file_name, mime, width, height, duration_seconds, size_bytes, content, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const file of files) {
      insert.run(versionId, file.role, file.fileName, file.mime, file.width, file.height, file.durationSeconds, file.content.length, file.content, file.sortOrder, timestamp);
    }
  }

  private changed(result: { changes: number | bigint }): boolean {
    return Number(result.changes) > 0;
  }
}
