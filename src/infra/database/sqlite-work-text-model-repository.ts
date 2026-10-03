// ------------------------------------------------------------------------
// 名称：sqlite-work-text-model-repository.ts
// 说明：作品文本模型选择数据访问的 SQLite 实现。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：每个作品最多一行；清除选择即删除该行。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { WorkTextModelRepository } from '../../domain/ports/work-text-model-repository';

/** 基于 SQLite 的作品文本模型选择仓库。 */
export class SqliteWorkTextModelRepository implements WorkTextModelRepository {
  /**
   * @param database 数据库连接。
   * @param now 返回当前时间的函数，测试时可注入固定时间。
   */
  constructor(
    private readonly database: DatabaseSync,
    private readonly now: () => Date = () => new Date()
  ) {}

  find(workId: number): string | null {
    const row = this.database.prepare('SELECT model_key FROM work_text_models WHERE work_id = ?').get(workId) as unknown as
      | { model_key: string }
      | undefined;
    return row === undefined ? null : row.model_key;
  }

  save(workId: number, modelKey: string | null): void {
    if (modelKey === null) {
      this.database.prepare('DELETE FROM work_text_models WHERE work_id = ?').run(workId);
      return;
    }
    this.database
      .prepare(
        `INSERT INTO work_text_models (work_id, model_key, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (work_id) DO UPDATE SET model_key = excluded.model_key, updated_at = excluded.updated_at`
      )
      .run(workId, modelKey, this.now().toISOString());
  }
}
