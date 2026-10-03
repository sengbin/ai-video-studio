// ------------------------------------------------------------------------
// 名称：migration-runner.test.ts
// 说明：迁移执行器的自动化测试：重建被引用表的迁移结束后必须确认外键约束已重新开启。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：用代理包装连接，模拟“重新开启外键的语句没有生效”；不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Migration, MigrationError } from './migration';
import { runMigrations } from './migration-runner';

/** 重新开启外键的语句。 */
const ENABLE_FOREIGN_KEYS_SQL = 'PRAGMA foreign_keys = ON';

/** 重建被引用表的迁移。 */
const REBUILD_MIGRATION: Migration = {
  version: 1,
  name: 'rebuild',
  sql: 'CREATE TABLE alpha (id INTEGER PRIMARY KEY);',
  rebuildsReferencedTables: true
};

/** 读取连接当前的外键开关。 */
function readForeignKeys(database: DatabaseSync): number {
  return (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys;
}

/** 包装连接：忽略“重新开启外键”的语句，其余原样转发。 */
function ignoreEnablingForeignKeys(database: DatabaseSync): DatabaseSync {
  return new Proxy(database, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      if (property === 'exec') {
        return (sql: string) => (sql === ENABLE_FOREIGN_KEYS_SQL ? undefined : target.exec(sql));
      }
      return value.bind(target);
    }
  });
}

test('重建被引用表的迁移：结束后外键约束已重新开启', () => {
  const database = new DatabaseSync(':memory:');
  try {
    runMigrations(database, [REBUILD_MIGRATION]);
    assert.equal(readForeignKeys(database), 1);
  } finally {
    database.close();
  }
});

test('重建被引用表的迁移：外键没有重新开启时抛错拒绝继续使用', () => {
  const database = new DatabaseSync(':memory:');
  try {
    assert.throws(() => runMigrations(ignoreEnablingForeignKeys(database), [REBUILD_MIGRATION]), (error: unknown) => {
      return error instanceof MigrationError && /外键约束没有重新开启/.test(error.message);
    });
  } finally {
    database.close();
  }
});

test('迁移本身失败且外键也没有重新开启：错误说明外键问题并保留迁移失败原因', () => {
  const database = new DatabaseSync(':memory:');
  const failing: Migration = { ...REBUILD_MIGRATION, sql: 'SELECT * FROM missing_table_for_test;' };
  try {
    assert.throws(() => runMigrations(ignoreEnablingForeignKeys(database), [failing]), (error: unknown) => {
      return (
        error instanceof MigrationError &&
        /外键约束没有重新开启/.test(error.message) &&
        error.cause instanceof MigrationError &&
        /执行迁移 1-rebuild 失败/.test(error.cause.message)
      );
    });
  } finally {
    database.close();
  }
});
