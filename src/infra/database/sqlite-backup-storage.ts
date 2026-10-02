// ------------------------------------------------------------------------
// 名称：sqlite-backup-storage.ts
// 说明：数据备份存储端口的 SQLite 实现：读取当前数据库的状态与各类数据数量，导出一致的快照，只读检查备份文件，并把备份文件制成待恢复的快照。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 node:sqlite 的 VACUUM INTO，不直接复制正在使用的数据库文件；表名为常量，不拼接外部输入。
// ------------------------------------------------------------------------

import { rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BackupDataCounts, BackupFileInspection, DatabaseStatus, PendingRestore } from '../../domain/models/backup';
import { BackupStorage } from '../../domain/ports/backup-storage';
import { DatabaseFilePaths } from './database-restore';
import { writeSnapshot } from './database-snapshot';
import { readSchemaVersion } from './migration-runner';

/** 各类数据数量对应的数据表。 */
const COUNT_TABLES: Readonly<Record<keyof BackupDataCounts, string>> = {
  projects: 'projects',
  works: 'works',
  episodes: 'episodes',
  assets: 'assets',
  shots: 'shots',
  videoResults: 'video_results'
};

/** SQLite 备份存储，操作当前打开的数据库连接。 */
export class SqliteBackupStorage implements BackupStorage {
  /**
   * @param database 当前正在使用的数据库连接。
   * @param paths 数据库相关文件的路径。
   * @param resultVideoDirectory 结果视频文件所在的目录，仅用于告知用户这些文件不在备份内。
   */
  constructor(
    private readonly database: DatabaseSync,
    private readonly paths: DatabaseFilePaths,
    private readonly resultVideoDirectory: string
  ) {}

  get databasePath(): string {
    return this.paths.databasePath;
  }

  readStatus(): DatabaseStatus {
    const counts = Object.fromEntries(
      Object.entries(COUNT_TABLES).map(([key, table]) => [key, this.countRows(table)])
    ) as unknown as BackupDataCounts;
    return {
      databasePath: this.paths.databasePath,
      sizeBytes: statSync(this.paths.databasePath).size,
      schemaVersion: readSchemaVersion(this.database),
      counts,
      resultVideoDirectory: this.resultVideoDirectory,
      autoBackupDirectory: this.paths.autoBackupDirectory
    };
  }

  exportSnapshot(targetPath: string): number {
    writeSnapshot(this.database, targetPath);
    return statSync(targetPath).size;
  }

  inspectFile(filePath: string): BackupFileInspection {
    // 只读打开，不会改动用户选择的文件。
    const file = new DatabaseSync(filePath, { readOnly: true });
    try {
      const tableRows = file.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      const check = file.prepare('PRAGMA quick_check').get() as { quick_check: string };
      return {
        sizeBytes: statSync(filePath).size,
        schemaVersion: readSchemaVersion(file),
        tableNames: tableRows.map((row) => row.name),
        integrity: check.quick_check
      };
    } finally {
      file.close();
    }
  }

  stageRestore(sourcePath: string): void {
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      // 制成独立快照再标记为待恢复：之后用户改动或删除原备份文件，不影响恢复。
      writeSnapshot(source, this.paths.pendingRestorePath);
    } finally {
      source.close();
    }
  }

  readPendingRestore(): PendingRestore | undefined {
    try {
      const stat = statSync(this.paths.pendingRestorePath);
      return { sizeBytes: stat.size, stagedAt: stat.mtime.toISOString() };
    } catch (error) {
      // 文件不存在就是没有待恢复的备份；其他读取错误照常抛出。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  discardPendingRestore(): void {
    rmSync(this.paths.pendingRestorePath, { force: true });
  }

  /** 统计一张表的行数；表名来自上面的常量。 */
  private countRows(table: string): number {
    const row = this.database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
    return row.total;
  }
}
