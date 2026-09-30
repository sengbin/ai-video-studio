// ------------------------------------------------------------------------
// 名称：transaction.ts
// 说明：事务辅助函数：在一个事务中执行操作，成功提交，失败回滚。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：迁移执行器与需要原子写入的仓库共用；SQLite 不支持嵌套事务，调用方不得在操作内再次调用。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';

/**
 * 在一个事务中执行操作：成功则提交，抛出异常则回滚并重新抛出。
 * 不支持嵌套，调用方不得在 operation 内再次调用。
 * @param database 数据库连接。
 * @param operation 需要原子执行的操作。
 */
export function runInTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
