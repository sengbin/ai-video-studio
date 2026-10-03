// ------------------------------------------------------------------------
// 名称：database-restore.ts
// 说明：数据库相关文件的路径约定，以及启动时应用“待恢复”备份：先把当前数据库备份到带时间戳的文件，再用待恢复的数据库替换它。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：必须在打开数据库连接之前调用（Windows 上不能替换已打开的文件），因此恢复需重新加载窗口后生效；失败时丢弃待恢复文件，避免每次启动都重复失败。
// ------------------------------------------------------------------------

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { formatBackupTimestamp } from '../../domain/rules/backup-rules';
import { writeSnapshot } from './database-snapshot';

/** 待恢复文件相对数据库文件的后缀。 */
const PENDING_RESTORE_SUFFIX = '.restore-pending';

/** 恢复前自动备份所在的子目录名，位于存储目录下。 */
const AUTO_BACKUP_DIRECTORY_NAME = 'backups';

/** 恢复前自动备份的文件名前缀，后接时间戳。 */
const AUTO_BACKUP_FILE_PREFIX = 'before-restore-';

/** 自动备份文件的扩展名。 */
const BACKUP_FILE_EXTENSION = '.sqlite';

/** 数据库相关文件的路径。 */
export interface DatabaseFilePaths {
  /** 数据库文件的绝对路径。 */
  readonly databasePath: string;
  /** 待恢复文件的绝对路径；存在即表示有恢复在等待下次启动应用。 */
  readonly pendingRestorePath: string;
  /** 恢复前自动备份所在的目录。 */
  readonly autoBackupDirectory: string;
}

/**
 * 按存储目录和数据库文件名确定各相关文件的路径。
 * @param storageDirectory 扩展的全局存储目录。
 * @param databaseFileName 数据库文件名。
 */
export function resolveDatabaseFilePaths(storageDirectory: string, databaseFileName: string): DatabaseFilePaths {
  const databasePath = path.join(storageDirectory, databaseFileName);
  return {
    databasePath,
    pendingRestorePath: `${databasePath}${PENDING_RESTORE_SUFFIX}`,
    autoBackupDirectory: path.join(storageDirectory, AUTO_BACKUP_DIRECTORY_NAME)
  };
}

/**
 * 应用待恢复的备份；没有待恢复文件时什么也不做。
 * @param paths 数据库相关文件的路径。
 * @param now 当前时间，用于自动备份的文件名。
 * @returns 已恢复且原来有数据库时，返回原数据库的自动备份文件路径；没有待恢复文件或原来没有数据库时返回 undefined。
 * @throws 备份或替换失败时抛出错误；此时待恢复文件已被丢弃，当前数据库保持不变。
 */
export function applyPendingRestore(paths: DatabaseFilePaths, now: Date): string | undefined {
  if (!existsSync(paths.pendingRestorePath)) {
    return undefined;
  }
  try {
    const backupPath = backupCurrentDatabase(paths, now);
    // 待恢复文件改名即替换数据库：同一目录内改名是原子的，失败时原数据库仍在。
    renameSync(paths.pendingRestorePath, paths.databasePath);
    return backupPath;
  } catch (error) {
    rmSync(paths.pendingRestorePath, { force: true });
    throw error;
  }
}

/** 把当前数据库备份到自动备份目录；原来没有数据库时不备份并返回 undefined；数据库无法经 SQLite 导出时原样复制文件。 */
function backupCurrentDatabase(paths: DatabaseFilePaths, now: Date): string | undefined {
  if (!existsSync(paths.databasePath)) {
    return undefined;
  }
  mkdirSync(paths.autoBackupDirectory, { recursive: true });
  const backupPath = path.join(
    paths.autoBackupDirectory,
    `${AUTO_BACKUP_FILE_PREFIX}${formatBackupTimestamp(now)}${BACKUP_FILE_EXTENSION}`
  );
  // 优先经 SQLite 导出而不是直接复制文件：能处理上次异常退出遗留的回滚日志，得到一致的快照。
  try {
    const current = new DatabaseSync(paths.databasePath);
    try {
      writeSnapshot(current, backupPath);
    } finally {
      current.close();
    }
  } catch {
    // 数据库已损坏、SQLite 无法导出时（这正是需要从备份恢复的典型场景），改为原样复制文件，保证被替换的数据仍留有一份；复制也失败则抛出，恢复不会继续。
    copyFileSync(paths.databasePath, backupPath);
  }
  return backupPath;
}
