// ------------------------------------------------------------------------
// 名称：asset-file-cleanup.ts
// 说明：资产文件的清理辅助：收集资产或版本引用的文件路径，在记录删除后删除不再被任何记录引用的磁盘文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：文件路径由内容哈希决定，资产文件、版本文件和多个资产可能共用同一个文件，所以必须先确认没有引用才能删除；清理在事务提交之后进行，删除失败只会留下一个无人引用的文件，不影响已提交的数据。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { AssetFileStore } from '../../domain/ports/asset-file-store';

/** 查询结果中只含文件路径的一行。 */
interface PathRow {
  readonly file_path: string;
}

/**
 * 收集一个资产引用的全部文件路径：资产自己的文件（上传与采用）和它所有版本的结果文件、缩略图。
 * @param assetId 资产标识。
 */
export function collectAssetFilePaths(database: DatabaseSync, assetId: number): string[] {
  const rows = database
    .prepare(
      `SELECT file_path FROM asset_files WHERE asset_id = ?
       UNION
       SELECT f.file_path FROM asset_version_files f JOIN asset_versions v ON v.id = f.version_id WHERE v.asset_id = ?`
    )
    .all(assetId, assetId) as unknown as PathRow[];
  return rows.map((row) => row.file_path);
}

/**
 * 收集一个版本引用的全部文件路径。
 * @param versionId 版本标识。
 */
export function collectVersionFilePaths(database: DatabaseSync, versionId: number): string[] {
  const rows = database
    .prepare('SELECT file_path FROM asset_version_files WHERE version_id = ?')
    .all(versionId) as unknown as PathRow[];
  return rows.map((row) => row.file_path);
}

/**
 * 删除不再被任何记录引用的文件；仍被引用的保留。应在删除记录的事务提交之后调用。
 * @param paths 可能已失去引用的文件路径，允许重复。
 */
export function removeUnreferencedFiles(database: DatabaseSync, store: AssetFileStore, paths: readonly string[]): void {
  const isReferenced = database.prepare(
    `SELECT 1 AS found FROM asset_files WHERE file_path = ?
     UNION ALL
     SELECT 1 FROM asset_version_files WHERE file_path = ?
     LIMIT 1`
  );
  for (const filePath of new Set(paths)) {
    if (isReferenced.get(filePath, filePath) !== undefined) {
      continue;
    }
    try {
      store.remove(filePath);
    } catch {
      // 记录已经提交，删不掉磁盘文件（如被其他程序占用）只会留下一个无人引用的文件，不能让整个操作失败。
    }
  }
}
