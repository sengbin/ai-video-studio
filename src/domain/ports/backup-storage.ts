// ------------------------------------------------------------------------
// 名称：backup-storage.ts
// 说明：数据备份的存储端口：读取当前数据库的状态，导出一致的快照，检查并准备恢复备份文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：实现位于 infra/database/sqlite-backup-storage.ts；恢复只“准备”，替换数据库文件发生在下次启动打开数据库之前。
// ------------------------------------------------------------------------

import { BackupAssetFileExport, BackupAssetFileInspection, BackupFileInspection, DatabaseStatus, PendingRestore } from '../models/backup';

/** 备份存储：服务通过它访问数据库文件，不直接依赖具体的数据库实现。 */
export interface BackupStorage {
  /** 当前数据库文件的绝对路径。 */
  readonly databasePath: string;

  /** 恢复前自动备份当前数据库的目录，文件名带时间戳。 */
  readonly autoBackupDirectory: string;

  /**
   * 读取当前数据库的位置、大小、结构版本和各类数据数量。
   * @throws 数据库无法打开（没有可用的连接）时抛出错误。
   */
  readStatus(): DatabaseStatus;

  /**
   * 把当前数据库导出为一个文件；导出的是一致的快照，目标文件已存在时被替换。
   * @param targetPath 目标文件的绝对路径。
   * @returns 导出文件的大小，单位为字节。
   * @throws 数据库无法打开时，或写入失败时抛出错误，不会留下写了一半的目标文件。
   */
  exportSnapshot(targetPath: string): number;

  /**
   * 把数据库引用的资产图片、音频文件复制到备份文件旁的文件夹（备份文件名 + `.files`），已存在的文件夹先清空；应在导出快照之后调用。
   * @param targetPath 备份文件的绝对路径。
   * @throws 数据库无法打开、备份位置在资产文件目录之内或复制失败时抛出错误。
   */
  exportAssetFiles(targetPath: string): BackupAssetFileExport;

  /**
   * 以只读方式检查备份文件引用的资产文件是否齐全。
   * @param filePath 备份文件的绝对路径。
   * @returns 检查结果；备份里没有资产文件路径列时返回 undefined。
   */
  inspectAssetFiles(filePath: string): BackupAssetFileInspection | undefined;

  /**
   * 以只读方式检查一个文件。
   * @param filePath 文件的绝对路径。
   * @throws 文件无法作为 SQLite 数据库读取时抛出错误。
   */
  inspectFile(filePath: string): BackupFileInspection;

  /**
   * 把备份文件制成一份独立的快照并标记为待恢复，重新加载窗口时才会替换当前数据库；已有的待恢复被替换。备份文件旁的文件夹里缺少的资产文件会立即补回资产文件目录（不覆盖也不删除现有文件）。
   * @param sourcePath 备份文件的绝对路径。
   * @throws 文件无法读取或写入失败时抛出错误。
   */
  stageRestore(sourcePath: string): void;

  /** 读取待生效的恢复；没有时返回 undefined。 */
  readPendingRestore(): PendingRestore | undefined;

  /** 放弃待生效的恢复；没有时什么也不做。 */
  discardPendingRestore(): void;
}
