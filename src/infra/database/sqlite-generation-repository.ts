// ------------------------------------------------------------------------
// 名称：sqlite-generation-repository.ts
// 说明：生成任务、结果视频的 SQLite 数据访问，以及按标识读取资产文件和尾帧图片内容。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：状态变更用 UPDATE ... WHERE status IN (...) 保证只作用于仍在进行的任务；成功时在一个事务内写结果并更新任务；新增任务时在同一事务内检查并插入，并由部分唯一索引（迁移 019）保证同一镜头组最多一个进行中的任务，冲突转为 ConflictError。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { ConflictError, FORM_LEVEL_ERROR_KEY, ProviderFailure } from '../../domain/errors';
import {
  ACTIVE_JOB_STATUSES,
  GroupLocation,
  JobFailure,
  JobSnapshot,
  JobStatus,
  NewResultFrame,
  NewVideoJob,
  NewVideoResult,
  VideoJobRecord,
  VideoResultRecord
} from '../../domain/models/generation';
import { AssetFileStore } from '../../domain/ports/asset-file-store';
import { GenerationRepository, JobMediaReader } from '../../domain/ports/generation-repository';
import { MediaInput } from '../../domain/ports/provider-adapters';
import { runInTransaction } from './transaction';

/** video_jobs 表的一行。 */
interface JobRow {
  readonly id: number;
  readonly group_id: number;
  readonly model_id: number;
  readonly status: JobStatus;
  readonly request_snapshot_json: string;
  readonly remote_job_id: string | null;
  readonly error_category: ProviderFailure | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly attempt: number;
  readonly prev_job_id: number | null;
  readonly first_frame_id: number | null;
  readonly created_at: string;
  readonly submitted_at: string | null;
  readonly finished_at: string | null;
}

/** video_results 表的一行。 */
interface ResultRow {
  readonly id: number;
  readonly job_id: number;
  readonly group_id: number;
  readonly file_path: string;
  readonly remote_url: string | null;
  readonly duration_seconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly size_bytes: number;
  readonly has_audio: number;
  readonly is_selected: number;
  readonly created_at: string;
}

/** 进行中的状态在 SQL 中的列表。 */
const ACTIVE_STATUS_SQL = ACTIVE_JOB_STATUSES.map((status) => `'${status}'`).join(', ');

/** 镜头组已有进行中的任务时再次提交的提示。 */
const ACTIVE_JOB_CONFLICT_MESSAGE = '这一组正在生成，完成或取消后才能再次提交。';

function toJob(row: JobRow): VideoJobRecord {
  return {
    id: row.id,
    groupId: row.group_id,
    modelId: row.model_id,
    status: row.status,
    snapshot: JSON.parse(row.request_snapshot_json) as JobSnapshot,
    remoteJobId: row.remote_job_id,
    failure: row.error_category === null ? null : { category: row.error_category, code: row.error_code, message: row.error_message ?? '' },
    attempt: row.attempt,
    prevJobId: row.prev_job_id,
    firstFrameId: row.first_frame_id,
    createdAt: row.created_at,
    submittedAt: row.submitted_at,
    finishedAt: row.finished_at
  };
}

function toResult(row: ResultRow): VideoResultRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    groupId: row.group_id,
    filePath: row.file_path,
    remoteUrl: row.remote_url,
    durationSeconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes,
    hasAudio: row.has_audio === 1,
    isSelected: row.is_selected === 1,
    createdAt: row.created_at
  };
}

/** 生成 n 个占位符。 */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** 基于 SQLite 的生成任务仓库，同时负责读取任务素材内容。 */
export class SqliteGenerationRepository implements GenerationRepository, JobMediaReader {
  /**
   * @param database 数据库连接。
   * @param assetFiles 资产文件内容的存储，读取资产文件时使用。
   */
  constructor(
    private readonly database: DatabaseSync,
    private readonly assetFiles: AssetFileStore
  ) {}

  insertJob(job: NewVideoJob, timestamp: string): VideoJobRecord {
    let id: number;
    try {
      id = runInTransaction(this.database, () => {
        // 检查与插入在同一个事务里；事务之外的并发写入由部分唯一索引兜底。
        if (this.hasActiveJob(job.groupId)) {
          throw new ConflictError(FORM_LEVEL_ERROR_KEY, ACTIVE_JOB_CONFLICT_MESSAGE);
        }
        const result = this.database
          .prepare(
            `INSERT INTO video_jobs (group_id, model_id, status, request_snapshot_json, attempt, prev_job_id, first_frame_id, created_at)
             VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(attempt), 0) + 1 FROM video_jobs WHERE group_id = ?), ?, ?, ?)`
          )
          .run(job.groupId, job.modelId, job.status, JSON.stringify(job.snapshot), job.groupId, job.prevJobId, job.firstFrameId, timestamp);
        return Number(result.lastInsertRowid);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: video_jobs.group_id')) {
        throw new ConflictError(FORM_LEVEL_ERROR_KEY, ACTIVE_JOB_CONFLICT_MESSAGE);
      }
      throw error;
    }
    return this.requireJob(id);
  }

  findJob(id: number): VideoJobRecord | undefined {
    const row = this.database.prepare('SELECT * FROM video_jobs WHERE id = ?').get(id) as unknown as JobRow | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  listJobsByGroups(groupIds: readonly number[]): VideoJobRecord[] {
    if (groupIds.length === 0) return [];
    const rows = this.database
      .prepare(`SELECT * FROM video_jobs WHERE group_id IN (${placeholders(groupIds.length)}) ORDER BY created_at DESC, id DESC`)
      .all(...groupIds) as unknown as JobRow[];
    return rows.map(toJob);
  }

  listJobsByStatus(statuses: readonly JobStatus[]): VideoJobRecord[] {
    if (statuses.length === 0) return [];
    const rows = this.database
      .prepare(`SELECT * FROM video_jobs WHERE status IN (${placeholders(statuses.length)}) ORDER BY id`)
      .all(...statuses) as unknown as JobRow[];
    return rows.map(toJob);
  }

  hasActiveJob(groupId: number): boolean {
    const row = this.database.prepare(`SELECT 1 AS found FROM video_jobs WHERE group_id = ? AND status IN (${ACTIVE_STATUS_SQL}) LIMIT 1`).get(groupId);
    return row !== undefined;
  }

  markSubmitted(id: number, remoteJobId: string, timestamp: string): boolean {
    const result = this.database
      .prepare("UPDATE video_jobs SET status = 'running', remote_job_id = ?, submitted_at = ? WHERE id = ? AND status = 'queued'")
      .run(remoteJobId, timestamp, id);
    return Number(result.changes) > 0;
  }

  markSucceeded(id: number, result: NewVideoResult, timestamp: string): VideoResultRecord | undefined {
    const resultId = runInTransaction(this.database, () => {
      const job = this.database.prepare(`SELECT group_id FROM video_jobs WHERE id = ? AND status IN (${ACTIVE_STATUS_SQL})`).get(id) as unknown as
        | { group_id: number }
        | undefined;
      if (job === undefined) return undefined;
      const inserted = this.database
        .prepare(
          `INSERT INTO video_results (job_id, group_id, file_path, remote_url, duration_seconds, width, height, size_bytes, has_audio, is_selected, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOT EXISTS (SELECT 1 FROM video_results WHERE group_id = ? AND is_selected = 1), ?)`
        )
        .run(id, job.group_id, result.filePath, result.remoteUrl, result.durationSeconds, result.width, result.height, result.sizeBytes, result.hasAudio ? 1 : 0, job.group_id, timestamp);
      this.database.prepare("UPDATE video_jobs SET status = 'succeeded', finished_at = ? WHERE id = ?").run(timestamp, id);
      return Number(inserted.lastInsertRowid);
    });
    return resultId === undefined ? undefined : this.findResult(resultId);
  }

  markFailed(id: number, failure: JobFailure, timestamp: string): boolean {
    const result = this.database
      .prepare(
        `UPDATE video_jobs SET status = 'failed', error_category = ?, error_code = ?, error_message = ?, finished_at = ?
          WHERE id = ? AND status IN (${ACTIVE_STATUS_SQL})`
      )
      .run(failure.category, failure.code, failure.message, timestamp, id);
    return Number(result.changes) > 0;
  }

  markCanceled(id: number, timestamp: string): boolean {
    const result = this.database
      .prepare(`UPDATE video_jobs SET status = 'canceled', finished_at = ? WHERE id = ? AND status IN (${ACTIVE_STATUS_SQL})`)
      .run(timestamp, id);
    return Number(result.changes) > 0;
  }

  releaseWaitingJob(id: number, firstFrameId: number): boolean {
    const result = this.database.prepare("UPDATE video_jobs SET status = 'queued', first_frame_id = ? WHERE id = ? AND status = 'waiting'").run(firstFrameId, id);
    return Number(result.changes) > 0;
  }

  saveResultFrame(resultId: number, frame: NewResultFrame, timestamp: string): number | undefined {
    return runInTransaction(this.database, () => {
      if (this.findResult(resultId) === undefined) return undefined;
      this.database.prepare('DELETE FROM result_frames WHERE result_id = ?').run(resultId);
      const inserted = this.database
        .prepare("INSERT INTO result_frames (result_id, kind, mime, width, height, content, created_at) VALUES (?, 'tail', ?, ?, ?, ?, ?)")
        .run(resultId, frame.mimeType, frame.width, frame.height, frame.data, timestamp);
      return Number(inserted.lastInsertRowid);
    });
  }

  findResultFrameId(resultId: number): number | undefined {
    const row = this.database.prepare('SELECT id FROM result_frames WHERE result_id = ? ORDER BY id DESC LIMIT 1').get(resultId) as unknown as { id: number } | undefined;
    return row?.id;
  }

  findResultByJob(jobId: number): VideoResultRecord | undefined {
    const row = this.database.prepare('SELECT * FROM video_results WHERE job_id = ? ORDER BY id DESC LIMIT 1').get(jobId) as unknown as ResultRow | undefined;
    return row === undefined ? undefined : toResult(row);
  }

  listResultsAwaitingFrame(): VideoResultRecord[] {
    const rows = this.database
      .prepare(
        `SELECT r.* FROM video_results r
          WHERE EXISTS (SELECT 1 FROM video_jobs w WHERE w.prev_job_id = r.job_id AND w.status = 'waiting')
            AND NOT EXISTS (SELECT 1 FROM result_frames f WHERE f.result_id = r.id)
          ORDER BY r.id`
      )
      .all() as unknown as ResultRow[];
    return rows.map(toResult);
  }

  listResultsByGroups(groupIds: readonly number[]): VideoResultRecord[] {
    if (groupIds.length === 0) return [];
    const rows = this.database
      .prepare(`SELECT * FROM video_results WHERE group_id IN (${placeholders(groupIds.length)}) ORDER BY created_at DESC, id DESC`)
      .all(...groupIds) as unknown as ResultRow[];
    return rows.map(toResult);
  }

  findResult(id: number): VideoResultRecord | undefined {
    const row = this.database.prepare('SELECT * FROM video_results WHERE id = ?').get(id) as unknown as ResultRow | undefined;
    return row === undefined ? undefined : toResult(row);
  }

  selectResult(id: number): boolean {
    return runInTransaction(this.database, () => {
      const result = this.findResult(id);
      if (result === undefined) return false;
      // 部分唯一索引限制每组最多一个采用版本，先取消原来的再设置新的。
      this.database.prepare('UPDATE video_results SET is_selected = 0 WHERE group_id = ? AND is_selected = 1').run(result.groupId);
      this.database.prepare('UPDATE video_results SET is_selected = 1 WHERE id = ?').run(id);
      return true;
    });
  }

  getGroupLocation(groupId: number): GroupLocation | undefined {
    const row = this.database
      .prepare(
        `SELECT w.project_id, e.work_id, ss.episode_id
           FROM shot_groups g
           JOIN storyboard_scripts ss ON ss.id = g.storyboard_script_id
           JOIN episodes e ON e.id = ss.episode_id
           JOIN works w ON w.id = e.work_id
          WHERE g.id = ?`
      )
      .get(groupId) as unknown as { project_id: number; work_id: number; episode_id: number } | undefined;
    return row === undefined ? undefined : { projectId: row.project_id, workId: row.work_id, episodeId: row.episode_id };
  }

  readAssetFile(id: number): MediaInput | undefined {
    const row = this.database.prepare('SELECT mime, file_path FROM asset_files WHERE id = ?').get(id) as unknown as
      | { mime: string; file_path: string }
      | undefined;
    return row === undefined ? undefined : { mimeType: row.mime, data: this.assetFiles.read(row.file_path) };
  }

  readResultFrame(id: number): MediaInput | undefined {
    const row = this.database.prepare('SELECT mime, content FROM result_frames WHERE id = ?').get(id) as unknown as
      | { mime: string; content: Uint8Array }
      | undefined;
    return row === undefined ? undefined : { mimeType: row.mime, data: row.content };
  }

  private requireJob(id: number): VideoJobRecord {
    const job = this.findJob(id);
    if (job === undefined) {
      throw new Error(`任务 ${id} 写入后读取不到。`);
    }
    return job;
  }
}
