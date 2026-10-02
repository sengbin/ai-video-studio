// ------------------------------------------------------------------------
// 名称：backup-fixture.ts
// 说明：数据备份相关测试共用的夹具：临时目录里的真实数据库文件（已升级到最新结构并写入项目）、备份存储，以及单独创建备份文件的方法。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除；清理时关闭数据库并删除临时目录。
// ------------------------------------------------------------------------

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../database-connection';
import { DatabaseFilePaths, resolveDatabaseFilePaths } from '../database-restore';
import { SqliteBackupStorage } from '../sqlite-backup-storage';

const NOW = '2026-01-01T00:00:00.000Z';

/** 夹具中的结果视频目录名，只用于告知用户，不会被创建。 */
const RESULT_VIDEO_DIRECTORY_NAME = 'videos';

/** 备份测试夹具。 */
export interface BackupFixture {
  /** 临时目录，相当于扩展的全局存储目录。 */
  readonly directory: string;
  readonly paths: DatabaseFilePaths;
  readonly database: DatabaseSync;
  readonly storage: SqliteBackupStorage;
  /** 在临时目录里创建一个已升级到最新结构、含指定项目的备份文件，返回其路径。 */
  createBackupFile(fileName: string, projectNames: readonly string[]): string;
  /** 关闭数据库并删除临时目录。 */
  cleanup(): void;
}

/** 向数据库写入一个项目。 */
export function insertProject(database: DatabaseSync, name: string): void {
  database.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, NOW, NOW);
}

/** 按创建顺序读出数据库中的全部项目名。 */
export function listProjectNames(database: DatabaseSync): string[] {
  const rows = database.prepare('SELECT name FROM projects ORDER BY id').all() as { name: string }[];
  return rows.map((row) => row.name);
}

/**
 * 创建夹具：数据库文件里已有一个名为“当前项目”的项目。
 * @returns 夹具；测试结束时必须调用 cleanup。
 */
export function createBackupFixture(): BackupFixture {
  const directory = mkdtempSync(join(tmpdir(), 'aigc-backup-test-'));
  const paths = resolveDatabaseFilePaths(directory, 'current.sqlite');
  const database = openDatabase(paths.databasePath);
  insertProject(database, '当前项目');
  const storage = new SqliteBackupStorage(database, paths, join(directory, RESULT_VIDEO_DIRECTORY_NAME));
  return {
    directory,
    paths,
    database,
    storage,
    createBackupFile(fileName, projectNames) {
      const filePath = join(directory, fileName);
      const backup = openDatabase(filePath);
      try {
        projectNames.forEach((name) => insertProject(backup, name));
      } finally {
        backup.close();
      }
      return filePath;
    },
    cleanup() {
      if (database.isOpen) {
        database.close();
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}
