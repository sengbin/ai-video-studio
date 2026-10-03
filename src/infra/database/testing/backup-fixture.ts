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
import { LocalAssetFileStore } from '../../storage/local-asset-file-store';
import { SqliteBackupStorage } from '../sqlite-backup-storage';

const NOW = '2026-01-01T00:00:00.000Z';

/** 夹具中的结果视频目录名，只用于告知用户，不会被创建。 */
const RESULT_VIDEO_DIRECTORY_NAME = 'videos';

/** 夹具中的资产文件目录名；目录在写入文件时才创建。 */
const ASSET_FILE_DIRECTORY_NAME = 'asset-files';

/** 备份测试夹具。 */
export interface BackupFixture {
  /** 临时目录，相当于扩展的全局存储目录。 */
  readonly directory: string;
  readonly paths: DatabaseFilePaths;
  readonly database: DatabaseSync;
  readonly storage: SqliteBackupStorage;
  /** 资产文件目录（相当于扩展存储目录下的 asset-files）。 */
  readonly assetDirectory: string;
  /** 在临时目录里创建一个已升级到最新结构、含指定项目的备份文件，返回其路径。 */
  createBackupFile(fileName: string, projectNames: readonly string[]): string;
  /** 关闭数据库并删除临时目录。 */
  cleanup(): void;
}

/** 向数据库写入一个项目。 */
export function insertProject(database: DatabaseSync, name: string): void {
  database.prepare('INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)').run(name, NOW, NOW);
}

/** 在资产文件目录里写入一个图片文件，并登记为一个新资产的文件记录，返回其相对路径。 */
export function seedAssetFile(fixture: BackupFixture, name: string, content: Buffer): string {
  const filePath = new LocalAssetFileStore(fixture.assetDirectory).write(content, 'image/png');
  fixture.database.prepare("INSERT INTO assets (kind, name, created_at, updated_at) VALUES ('scene', ?, 't', 't')").run(name);
  fixture.database
    .prepare("INSERT INTO asset_files (asset_id, role, source, file_name, mime, size_bytes, file_path, created_at) VALUES (last_insert_rowid(), 'reference', 'upload', ?, 'image/png', ?, ?, 't')")
    .run(`${name}.png`, content.length, filePath);
  return filePath;
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
  const assetDirectory = join(directory, ASSET_FILE_DIRECTORY_NAME);
  const storage = new SqliteBackupStorage(database, paths, join(directory, RESULT_VIDEO_DIRECTORY_NAME), assetDirectory);
  return {
    directory,
    paths,
    database,
    storage,
    assetDirectory,
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
