// ------------------------------------------------------------------------
// 名称：database-connection.ts
// 说明：打开本地 SQLite 数据库，启用外键并在启动时自动升级结构。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用 Node 内置的 node:sqlite；升级前若库已有数据，先用 VACUUM INTO 备份。
// ------------------------------------------------------------------------

import { DatabaseSync } from 'node:sqlite';
import { writeSnapshot } from './database-snapshot';
import { Migration } from './migration';
import { getPendingMigrations, readSchemaVersion, runMigrations } from './migration-runner';
import { MIGRATIONS } from './migrations';

/** 内存数据库的路径标识，测试时使用，不做备份。 */
export const IN_MEMORY_DATABASE_PATH = ':memory:';

/**
 * 打开数据库并升级到最新结构。
 * @param filePath 数据库文件路径，或 IN_MEMORY_DATABASE_PATH。
 * @param migrations 迁移列表，默认使用全部内置迁移。
 * @returns 已启用外键、结构为最新版本的连接。
 * @throws MigrationError 升级失败或数据库版本高于程序支持的版本；连接会被关闭。
 */
export function openDatabase(filePath: string, migrations: readonly Migration[] = MIGRATIONS): DatabaseSync {
  const database = new DatabaseSync(filePath);
  try {
    database.exec('PRAGMA foreign_keys = ON');
    backupBeforeUpgrade(database, filePath, migrations);
    runMigrations(database, migrations);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/** 已有数据且存在待执行迁移时，把升级前的库备份为 `<文件>.backup-v<版本>`。 */
function backupBeforeUpgrade(database: DatabaseSync, filePath: string, migrations: readonly Migration[]): void {
  if (filePath === IN_MEMORY_DATABASE_PATH) {
    return;
  }
  const currentVersion = readSchemaVersion(database);
  if (currentVersion === 0 || getPendingMigrations(currentVersion, migrations).length === 0) {
    return;
  }
  writeSnapshot(database, `${filePath}.backup-v${currentVersion}`);
}
