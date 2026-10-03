// ------------------------------------------------------------------------
// 名称：asset-file-backup.ts
// 说明：资产图片、音频文件的备份与恢复：备份时把数据库引用的文件复制到备份文件旁的同名文件夹，恢复时从该文件夹补回缺少的文件，并检查备份的文件是否齐全。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：备份文件夹名为“备份文件名 + .files”；只复制数据库引用的文件，恢复只补充缺少的文件、不删除任何现有文件（文件名由内容哈希决定，同名即同内容）；备份库里的路径不可信，逐个经 resolveInsideRoot 校验，不合法的按缺失处理；资产文件表没有文件路径列的备份无法读出文件清单，视为没有资产文件。
// ------------------------------------------------------------------------

import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { BackupAssetFileExport, BackupAssetFileInspection } from '../../domain/models/backup';
import { resolveInsideRoot } from '../storage/relative-path';

/** 备份文件夹相对备份文件的后缀。 */
const BACKUP_FILES_SUFFIX = '.files';

/**
 * 备份文件对应的资产文件夹路径。
 * @param backupPath 备份文件的绝对路径。
 */
export function assetFilesDirectoryOf(backupPath: string): string {
  return `${backupPath}${BACKUP_FILES_SUFFIX}`;
}

/** 数据库里是否有资产文件路径列。 */
function hasFilePathColumn(database: DatabaseSync): boolean {
  const columns = database.prepare('PRAGMA table_info(asset_files)').all() as Array<{ name: string }>;
  return columns.some((column) => column.name === 'file_path');
}

/** 读取数据库引用的全部资产文件路径（去重）；没有路径列时返回 undefined。 */
function listReferencedPaths(database: DatabaseSync): string[] | undefined {
  if (!hasFilePathColumn(database)) {
    return undefined;
  }
  const rows = database
    .prepare('SELECT file_path FROM asset_files UNION SELECT file_path FROM asset_version_files')
    .all() as unknown as Array<{ file_path: string }>;
  return rows.map((row) => row.file_path);
}

/** 解析根目录下的文件，路径不合法或文件不存在时返回 undefined。 */
function resolveExisting(root: string, filePath: string): string | undefined {
  try {
    const absolute = resolveInsideRoot(root, filePath);
    return existsSync(absolute) ? absolute : undefined;
  } catch {
    return undefined;
  }
}

/** 两个目录是否相同或互相包含。 */
function overlaps(first: string, second: string): boolean {
  const isInside = (parent: string, child: string): boolean => {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  };
  return isInside(first, second) || isInside(second, first);
}

/**
 * 把数据库引用的资产文件复制到备份文件旁的文件夹；文件夹已存在时先清空，保证与本次备份一致。
 * @param database 当前数据库连接。
 * @param assetDirectory 资产文件根目录。
 * @param backupPath 备份文件的绝对路径。
 * @throws Error 备份文件夹与资产文件目录相同或互相包含；复制失败。
 */
export function copyAssetFilesToBackup(database: DatabaseSync, assetDirectory: string, backupPath: string): BackupAssetFileExport {
  const directory = assetFilesDirectoryOf(backupPath);
  // 目标与资产文件目录重叠时清空目标会删掉正在使用的文件，必须拒绝。
  if (overlaps(assetDirectory, directory)) {
    throw new Error('备份位置不能在资产文件目录之内，请换一个位置。');
  }
  const paths = listReferencedPaths(database) ?? [];
  rmSync(directory, { recursive: true, force: true });
  let fileCount = 0;
  let sizeBytes = 0;
  let missingCount = 0;
  for (const filePath of paths) {
    const source = resolveExisting(assetDirectory, filePath);
    if (source === undefined) {
      missingCount += 1;
      continue;
    }
    const target = resolveInsideRoot(directory, filePath);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
    fileCount += 1;
    sizeBytes += statSync(target).size;
  }
  return { directory, fileCount, sizeBytes, missingCount };
}

/**
 * 检查备份文件引用的资产文件是否齐全：在备份文件旁的文件夹或当前资产文件目录里能找到就算可用。
 * @param backupDatabase 以只读方式打开的备份数据库。
 * @param backupPath 备份文件的绝对路径。
 * @param assetDirectory 当前资产文件根目录。
 * @returns 检查结果；备份里没有资产文件路径列时返回 undefined。
 */
export function inspectBackupAssetFiles(
  backupDatabase: DatabaseSync,
  backupPath: string,
  assetDirectory: string
): BackupAssetFileInspection | undefined {
  const paths = listReferencedPaths(backupDatabase);
  if (paths === undefined) {
    return undefined;
  }
  const directory = assetFilesDirectoryOf(backupPath);
  const availableCount = paths.filter(
    (filePath) => resolveExisting(directory, filePath) !== undefined || resolveExisting(assetDirectory, filePath) !== undefined
  ).length;
  return { directory, referencedCount: paths.length, availableCount };
}

/**
 * 把备份文件夹里的资产文件补回当前资产文件目录：只复制缺少的文件，不覆盖也不删除现有文件。
 * @param backupDatabase 以只读方式打开的备份数据库。
 * @param backupPath 备份文件的绝对路径。
 * @param assetDirectory 当前资产文件根目录。
 */
export function restoreAssetFilesFromBackup(backupDatabase: DatabaseSync, backupPath: string, assetDirectory: string): void {
  const paths = listReferencedPaths(backupDatabase) ?? [];
  const directory = assetFilesDirectoryOf(backupPath);
  for (const filePath of paths) {
    if (resolveExisting(assetDirectory, filePath) !== undefined) {
      continue;
    }
    const source = resolveExisting(directory, filePath);
    if (source === undefined) {
      continue;
    }
    const target = resolveInsideRoot(assetDirectory, filePath);
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
}
