// ------------------------------------------------------------------------
// 名称：sqlite-stage-run-repository.ts
// 说明：阶段生成记录与创意章节数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：状态变更只在预期的当前状态下生效（如只有运行中的记录才能标记成功），避免迟到的写入覆盖已取消或已失败的结果。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { ChapterDraft } from '../../domain/models/creative';
import {
  NewStageRun,
  ReviewPatch,
  ReviewStatus,
  StageKind,
  StageProgress,
  StageRun,
  StageRunStatus,
  StageTarget
} from '../../domain/models/stage-run';
import { ChapterRepository } from '../../domain/ports/chapter-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { runInTransaction } from './transaction';

/** stage_runs 表的一行。 */
interface StageRunRow {
  readonly id: number;
  readonly work_id: number;
  readonly episode_id: number | null;
  readonly stage: StageKind;
  readonly version: number;
  readonly input_json: string;
  readonly status: StageRunStatus;
  readonly review_status: ReviewStatus;
  readonly is_current: number;
  readonly revision: number;
  readonly source_run_id: number | null;
  readonly source_revision: number | null;
  readonly model_info: string | null;
  readonly progress_json: string | null;
  readonly raw_output: string | null;
  readonly error_message: string | null;
  readonly created_at: string;
  readonly finished_at: string | null;
  readonly approved_at: string | null;
  readonly applied_at: string | null;
}

/** chapters 表的一行。 */
interface ChapterRow {
  readonly seq: number;
  readonly title: string;
  readonly content: string;
}

/** 同一目标的匹配条件；episode_id 为空时按 0 处理，与部分唯一索引一致。 */
const TARGET_CONDITION = 'work_id = ? AND stage = ? AND ifnull(episode_id, 0) = ifnull(?, 0)';

/** 把数据库行转换为领域记录。 */
function toStageRun(row: StageRunRow): StageRun {
  return {
    id: row.id,
    workId: row.work_id,
    episodeId: row.episode_id,
    stage: row.stage,
    version: row.version,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    status: row.status,
    reviewStatus: row.review_status,
    isCurrent: row.is_current === 1,
    revision: row.revision,
    sourceRunId: row.source_run_id,
    sourceRevision: row.source_revision,
    modelInfo: row.model_info,
    progress: row.progress_json === null ? null : (JSON.parse(row.progress_json) as StageProgress),
    rawOutput: row.raw_output,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    approvedAt: row.approved_at,
    appliedAt: row.applied_at
  };
}

/** 基于 SQLite 的阶段记录仓库。 */
export class SqliteStageRunRepository implements StageRunRepository {
  constructor(private readonly database: DatabaseSync) {}

  findById(id: number): StageRun | undefined {
    const row = this.database.prepare('SELECT * FROM stage_runs WHERE id = ?').get(id) as unknown as StageRunRow | undefined;
    return row === undefined ? undefined : toStageRun(row);
  }

  findCurrent(target: StageTarget): StageRun | undefined {
    return this.findOne(`${TARGET_CONDITION} AND is_current = 1`, target);
  }

  findRunning(target: StageTarget): StageRun | undefined {
    return this.findOne(`${TARGET_CONDITION} AND status = 'running'`, target);
  }

  listVersions(target: StageTarget): StageRun[] {
    const rows = this.database
      .prepare(`SELECT * FROM stage_runs WHERE ${TARGET_CONDITION} ORDER BY version DESC`)
      .all(target.workId, target.stage, target.episodeId) as unknown as StageRunRow[];
    return rows.map(toStageRun);
  }

  create(input: NewStageRun, timestamp: string): StageRun {
    const next = this.database
      .prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS version FROM stage_runs WHERE ${TARGET_CONDITION}`)
      .get(input.workId, input.stage, input.episodeId) as unknown as { version: number };
    const result = this.database
      .prepare(
        `INSERT INTO stage_runs
           (work_id, episode_id, stage, version, input_json, source_run_id, source_revision, model_info, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.workId,
        input.episodeId,
        input.stage,
        next.version,
        JSON.stringify(input.input),
        input.sourceRunId,
        input.sourceRevision,
        input.modelInfo,
        timestamp
      );
    return this.requireRun(Number(result.lastInsertRowid));
  }

  markRunning(id: number): StageRun | undefined {
    return this.changeStatus(
      id,
      "status IN ('failed', 'canceled')",
      "status = 'running', error_message = NULL, raw_output = NULL, finished_at = NULL"
    );
  }

  reopen(id: number): StageRun | undefined {
    return this.changeStatus(
      id,
      "status = 'succeeded'",
      "status = 'running', error_message = NULL, raw_output = NULL, finished_at = NULL, progress_json = NULL"
    );
  }

  updateProgress(id: number, progress: StageProgress): StageRun | undefined {
    this.database.prepare('UPDATE stage_runs SET progress_json = ? WHERE id = ?').run(JSON.stringify(progress), id);
    return this.findById(id);
  }

  markSucceeded(id: number, timestamp: string): StageRun | undefined {
    return this.changeStatus(id, "status = 'running'", "status = 'succeeded', error_message = NULL, raw_output = NULL, finished_at = ?", [
      timestamp
    ]);
  }

  markFailed(id: number, errorMessage: string, rawOutput: string | null, timestamp: string): StageRun | undefined {
    return this.changeStatus(id, "status = 'running'", "status = 'failed', error_message = ?, raw_output = ?, finished_at = ?", [
      errorMessage,
      rawOutput,
      timestamp
    ]);
  }

  markCanceled(id: number, timestamp: string): StageRun | undefined {
    return this.changeStatus(id, "status = 'running'", "status = 'canceled', finished_at = ?", [timestamp]);
  }

  approve(id: number, patch: ReviewPatch, inTransaction?: () => void): StageRun | undefined {
    return runInTransaction(this.database, () => {
      const run = this.findById(id);
      if (run === undefined) {
        return undefined;
      }
      inTransaction?.();
      this.database
        .prepare(`UPDATE stage_runs SET is_current = 0 WHERE ${TARGET_CONDITION} AND is_current = 1 AND id <> ?`)
        .run(run.workId, run.stage, run.episodeId, id);
      return this.applyEdit(id, patch);
    });
  }

  applyEdit(id: number, patch: ReviewPatch): StageRun | undefined {
    this.database
      .prepare('UPDATE stage_runs SET review_status = ?, is_current = ?, revision = ?, approved_at = ? WHERE id = ?')
      .run(patch.reviewStatus, patch.isCurrent ? 1 : 0, patch.revision, patch.approvedAt, id);
    return this.findById(id);
  }

  failInterrupted(errorMessage: string, timestamp: string): number {
    const result = this.database
      .prepare("UPDATE stage_runs SET status = 'failed', error_message = ?, finished_at = ? WHERE status = 'running'")
      .run(errorMessage, timestamp);
    return Number(result.changes);
  }

  private findOne(condition: string, target: StageTarget): StageRun | undefined {
    const row = this.database
      .prepare(`SELECT * FROM stage_runs WHERE ${condition} LIMIT 1`)
      .get(target.workId, target.stage, target.episodeId) as unknown as StageRunRow | undefined;
    return row === undefined ? undefined : toStageRun(row);
  }

  /** 仅当记录处于预期状态时才更新，返回更新后（或未变化的）记录。 */
  private changeStatus(id: number, expected: string, assignments: string, parameters: (string | null)[] = []): StageRun | undefined {
    this.database.prepare(`UPDATE stage_runs SET ${assignments} WHERE id = ? AND ${expected}`).run(...parameters, id);
    return this.findById(id);
  }

  private requireRun(id: number): StageRun {
    const run = this.findById(id);
    if (run === undefined) {
      throw new Error(`阶段记录 ${id} 写入后读取失败。`);
    }
    return run;
  }
}

/** 基于 SQLite 的创意章节仓库。 */
export class SqliteChapterRepository implements ChapterRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(runId: number): ChapterDraft[] {
    const rows = this.database
      .prepare('SELECT seq, title, content FROM chapters WHERE run_id = ? ORDER BY seq')
      .all(runId) as unknown as ChapterRow[];
    return rows.map((row) => ({ seq: row.seq, title: row.title, content: row.content }));
  }

  save(runId: number, chapter: ChapterDraft, timestamp: string): void {
    this.database
      .prepare(
        `INSERT INTO chapters (run_id, seq, title, content, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (run_id, seq) DO UPDATE SET title = excluded.title, content = excluded.content`
      )
      .run(runId, chapter.seq, chapter.title, chapter.content, timestamp);
  }

  clear(runId: number): void {
    this.database.prepare('DELETE FROM chapters WHERE run_id = ?').run(runId);
  }
}
