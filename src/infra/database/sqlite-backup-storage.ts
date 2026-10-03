// ------------------------------------------------------------------------
// 名称：sqlite-backup-storage.ts
// 说明：数据备份存储端口的 SQLite 实现：读取当前数据库的状态与各类数据数量，导出一致的快照，备份与恢复资产文件，只读检查备份文件，并把备份文件制成待恢复的快照。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 node:sqlite 的 VACUUM INTO，不直接复制正在使用的数据库文件；表名为常量，不拼接外部输入；数据库无法打开时不带连接构造，只提供检查备份文件、准备与放弃待恢复。
// ------------------------------------------------------------------------

import { rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BackupAssetFileExport, BackupAssetFileInspection, BackupDataCounts, BackupFileInspection, DatabaseStatus, PendingRestore } from '../../domain/models/backup';
import { BackupStorage } from '../../domain/ports/backup-storage';
import { copyAssetFilesToBackup, inspectBackupAssetFiles, restoreAssetFilesFromBackup } from './asset-file-backup';
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

/** SQLite 备份存储，操作当前打开的数据库连接；数据库无法打开时可不带连接使用，只提供不依赖连接的恢复准备能力。 */
export class SqliteBackupStorage implements BackupStorage {
  /**
   * @param database 当前正在使用的数据库连接；数据库无法打开时为 undefined，此时只能检查备份文件、准备与放弃待恢复，读取状态和导出快照会抛出错误。
   * @param paths 数据库相关文件的路径。
   * @param resultVideoDirectory 结果视频文件所在的目录，仅用于告知用户这些文件不在备份内。
   * @param assetFileDirectory 资产图片、音频文件所在的目录；备份时把数据库引用的文件复制到备份文件旁，恢复时补回缺少的文件。
   */
  constructor(
    private readonly database: DatabaseSync | undefined,
    private readonly paths: DatabaseFilePaths,
    private readonly resultVideoDirectory: string,
    private readonly assetFileDirectory: string
  ) {}

  get databasePath(): string {
    return this.paths.databasePath;
  }

  get autoBackupDirectory(): string {
    return this.paths.autoBackupDirectory;
  }

  readStatus(): DatabaseStatus {
    const database = this.requireDatabase();
    const counts = Object.fromEntries(
      Object.entries(COUNT_TABLES).map(([key, table]) => [key, this.countRows(database, table)])
    ) as unknown as BackupDataCounts;
    return {
      databasePath: this.paths.databasePath,
      sizeBytes: statSync(this.paths.databasePath).size,
      schemaVersion: readSchemaVersion(database),
      counts,
      resultVideoDirectory: this.resultVideoDirectory,
      assetFileDirectory: this.assetFileDirectory
    };
  }

  exportSnapshot(targetPath: string): number {
    writeSnapshot(this.requireDatabase(), targetPath);
    return statSync(targetPath).size;
  }

  exportAssetFiles(targetPath: string): BackupAssetFileExport {
    return copyAssetFilesToBackup(this.requireDatabase(), this.assetFileDirectory, targetPath);
  }

  inspectAssetFiles(filePath: string): BackupAssetFileInspection | undefined {
    const file = new DatabaseSync(filePath, { readOnly: true });
    try {
      return inspectBackupAssetFiles(file, filePath, this.assetFileDirectory);
    } finally {
      file.close();
    }
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
      // 先补回资产文件再制成待恢复：补文件失败时不会留下待恢复；缺少的文件补进去不影响现有数据，即使之后取消恢复也只是多出无人引用的文件。
      restoreAssetFilesFromBackup(source, sourcePath, this.assetFileDirectory);
      // 制成独立快照再标记为待恢复：之后用户改动或删除原备份文件，不影响恢复。
      writeSnapshot(source, this.paths.pendingRestorePath);
    } finally {
      source.close();
    }
  }

  readPendingRestore(): PendingRestore | undefined {
    try {
      const stat = statSync(this.paths.pendingRestorePath);
      return { sizeBytes: stat.size, stagedAt: stat.mtime.toISOString(), token: `${stat.mtimeMs}-${stat.size}` };
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

  /** 取当前数据库连接；数据库无法打开时抛出明确的错误。 */
  private requireDatabase(): DatabaseSync {
    if (this.database === undefined) {
      throw new Error('数据库无法打开，当前没有可用的数据库连接。');
    }
    return this.database;
  }

  /** 统计一张表的行数；表名来自上面的常量。 */
  private countRows(database: DatabaseSync, table: string): number {
    const row = database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
    return row.total;
  }
}
