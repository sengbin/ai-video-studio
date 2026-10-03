// ------------------------------------------------------------------------
// 名称：migration-runner.ts
// 说明：数据库迁移执行器，按结构版本号顺序执行尚未应用的迁移。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：版本号保存在 SQLite 的 PRAGMA user_version，每个迁移在独立事务中执行；重建被引用表的迁移会暂时关闭外键，结束后读取 PRAGMA foreign_keys 确认已重新开启。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { Migration, MigrationError } from './migration';
import { runInTransaction } from './transaction';

/** PRAGMA foreign_keys 读取到的“已启用”取值。 */
const FOREIGN_KEYS_ENABLED = 1;

/**
 * 读取数据库当前的结构版本号；新库为 0。
 * @param database 已打开的数据库连接。
 */
export function readSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number };
  return row.user_version;
}

/**
 * 返回版本号大于当前版本的迁移，按版本升序。
 * @param currentVersion 数据库当前结构版本。
 * @param migrations 全部迁移。
 */
export function getPendingMigrations(currentVersion: number, migrations: readonly Migration[]): Migration[] {
  return migrations.filter((migration) => migration.version > currentVersion);
}

/**
 * 按顺序执行尚未应用的迁移；某个迁移失败时回滚它并停在上一个版本。
 * @param database 已打开的数据库连接。
 * @param migrations 全部迁移，版本号必须从 1 开始连续。
 * @throws MigrationError 迁移配置不合法、数据库版本高于代码支持的版本，或迁移执行失败。
 */
export function runMigrations(database: DatabaseSync, migrations: readonly Migration[]): void {
  assertMigrationsConsecutive(migrations);

  const currentVersion = readSchemaVersion(database);
  const latestVersion = migrations.length;
  if (currentVersion > latestVersion) {
    throw new MigrationError(
      `数据库结构版本 ${currentVersion} 高于当前程序支持的版本 ${latestVersion}，请升级扩展后再打开。`
    );
  }

  for (const migration of getPendingMigrations(currentVersion, migrations)) {
    applyMigration(database, migration);
  }
}

/** 校验迁移版本号从 1 开始连续递增。 */
function assertMigrationsConsecutive(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new MigrationError(
        `迁移 ${migration.name} 的版本号为 ${migration.version}，应为 ${expectedVersion}。`
      );
    }
  });
}

/** 在一个事务中执行单个迁移并更新版本号。 */
function applyMigration(database: DatabaseSync, migration: Migration): void {
  const rebuilds = migration.rebuildsReferencedTables === true;
  let failure: MigrationError | undefined;
  try {
    // foreign_keys 在事务内无法切换，必须在事务外关闭。
    if (rebuilds) {
      database.exec('PRAGMA foreign_keys = OFF');
    }
    runInTransaction(database, () => {
      database.exec(migration.sql);
      if (rebuilds && database.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new MigrationError('迁移后存在违反外键约束的数据。');
      }
      // PRAGMA 不支持参数绑定，版本号来自受控的整数，直接拼接。
      database.exec(`PRAGMA user_version = ${migration.version}`);
    });
  } catch (error) {
    failure = new MigrationError(`执行迁移 ${migration.version}-${migration.name} 失败。`, { cause: error });
  }
  if (rebuilds) {
    restoreForeignKeys(database, failure);
  }
  if (failure !== undefined) {
    throw failure;
  }
}

/**
 * 重新开启外键约束并读取 PRAGMA foreign_keys 确认已生效；未生效时拒绝继续使用该连接。
 * @param database 已打开的数据库连接。
 * @param migrationFailure 此前迁移本身的失败原因；有时作为新错误的原因保留。
 * @throws MigrationError 外键约束没有重新开启。
 */
function restoreForeignKeys(database: DatabaseSync, migrationFailure: MigrationError | undefined): void {
  database.exec('PRAGMA foreign_keys = ON');
  const row = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
  if (row.foreign_keys !== FOREIGN_KEYS_ENABLED) {
    throw new MigrationError('迁移结束后外键约束没有重新开启，已拒绝继续使用该数据库。', { cause: migrationFailure });
  }
}
