// ------------------------------------------------------------------------
// 名称：sqlite-work-repository.ts
// 说明：作品仓库的 SQLite 实现：查询作品，在一个事务内创建作品、第 1 集与素材文件，修改作品名称与形态。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：素材按二进制保存在 work_sources 表，sort_order 记录上传顺序；删除作品由外键级联清除其下全部数据。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { NewWorkSource, Work, WorkInput, WorkKind, WorkSourceKind, WorkSourceType, WorkUpdate } from '../../domain/models/work';
import { WorkRepository } from '../../domain/ports/work-repository';
import { runInTransaction } from './transaction';

/** works 表的一行。 */
interface WorkRow {
  readonly id: number;
  readonly project_id: number;
  readonly name: string;
  readonly kind: WorkKind;
  readonly source_type: WorkSourceType | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** 基于 SQLite 的作品仓库。 */
export class SqliteWorkRepository implements WorkRepository {
  constructor(private readonly database: DatabaseSync) {}

  listByProject(projectId: number): Work[] {
    const rows = this.database
      .prepare('SELECT * FROM works WHERE project_id = ? ORDER BY created_at DESC, id DESC')
      .all(projectId) as unknown as WorkRow[];
    return rows.map(toWork);
  }

  listBySource(sourceType: WorkSourceType): Work[] {
    // 旧数据没有素材来源，按文字灵感处理。
    const rows = this.database
      .prepare("SELECT * FROM works WHERE source_type = ? OR (? = 'text' AND source_type IS NULL) ORDER BY created_at DESC, id DESC")
      .all(sourceType, sourceType) as unknown as WorkRow[];
    return rows.map(toWork);
  }

  findById(id: number): Work | undefined {
    const row = this.database.prepare('SELECT * FROM works WHERE id = ?').get(id) as unknown as WorkRow | undefined;
    return row === undefined ? undefined : toWork(row);
  }

  findByName(projectId: number, name: string): Work | undefined {
    const row = this.database
      .prepare('SELECT * FROM works WHERE project_id = ? AND name = ?')
      .get(projectId, name) as unknown as WorkRow | undefined;
    return row === undefined ? undefined : toWork(row);
  }

  insert(projectId: number, input: WorkInput, sources: readonly NewWorkSource[], timestamp: string): Work {
    return runInTransaction(this.database, () => {
      const result = this.database
        .prepare('INSERT INTO works (project_id, name, kind, source_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(projectId, input.name, input.kind, input.sourceType, timestamp, timestamp);
      const workId = Number(result.lastInsertRowid);

      if (input.kind === 'single') {
        this.database
          .prepare('INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 1, ?, ?, ?)')
          .run(workId, input.name, timestamp, timestamp);
      }

      this.insertSources(workId, sources, timestamp);

      const created = this.findById(workId);
      if (created === undefined) {
        throw new Error(`作品 ${workId} 写入后读取失败。`);
      }
      return created;
    });
  }

  update(id: number, input: WorkUpdate, timestamp: string): Work | undefined {
    return runInTransaction(this.database, () => {
      const current = this.findById(id);
      if (current === undefined) {
        return undefined;
      }
      this.database.prepare('UPDATE works SET name = ?, kind = ?, updated_at = ? WHERE id = ?').run(input.name, input.kind, timestamp, id);

      if (input.kind !== current.kind) {
        if (input.kind === 'single') {
          this.database
            .prepare('INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 1, ?, ?, ?)')
            .run(id, input.name, timestamp, timestamp);
        } else {
          this.database.prepare('DELETE FROM episodes WHERE work_id = ? AND seq = 1').run(id);
        }
      } else if (input.kind === 'single' && input.name !== current.name) {
        // 只改还跟着作品名的集标题，用户自己改过的标题保持不变。
        this.database
          .prepare('UPDATE episodes SET title = ?, updated_at = ? WHERE work_id = ? AND seq = 1 AND title = ?')
          .run(input.name, timestamp, id, current.name);
      }

      if (input.images !== undefined) {
        this.database.prepare("DELETE FROM work_sources WHERE work_id = ? AND kind = 'image'").run(id);
        this.insertSources(id, input.images, timestamp);
      }
      return this.findById(id);
    });
  }

  listSources(workId: number, kind: WorkSourceKind): NewWorkSource[] {
    const rows = this.database
      .prepare('SELECT kind, file_name, mime, content FROM work_sources WHERE work_id = ? AND kind = ? ORDER BY sort_order, id')
      .all(workId, kind) as unknown as Array<{ kind: WorkSourceKind; file_name: string; mime: string; content: Uint8Array }>;
    return rows.map((row) => ({ kind: row.kind, fileName: row.file_name, mime: row.mime, content: new Uint8Array(row.content) }));
  }

  remove(id: number): boolean {
    return Number(this.database.prepare('DELETE FROM works WHERE id = ?').run(id).changes) > 0;
  }

  /** 按给定顺序写入素材文件，sort_order 从 0 开始。 */
  private insertSources(workId: number, sources: readonly NewWorkSource[], timestamp: string): void {
    const insertSource = this.database.prepare(
      `INSERT INTO work_sources (work_id, kind, file_name, mime, size_bytes, content, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    sources.forEach((source, index) => {
      insertSource.run(workId, source.kind, source.fileName, source.mime, source.content.length, source.content, index, timestamp);
    });
  }
}

/** 数据库行转领域对象；旧数据没有素材来源时按文字灵感处理。 */
function toWork(row: WorkRow): Work {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    sourceType: row.source_type ?? 'text',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
