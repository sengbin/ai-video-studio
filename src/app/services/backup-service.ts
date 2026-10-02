// ------------------------------------------------------------------------
// 名称：backup-service.ts
// 说明：数据备份应用服务：展示数据库状态，备份到用户选择的文件，选择并校验备份文件，准备恢复（重新加载窗口后生效）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code：数据库文件经 BackupStorage 访问，文件对话框与重新加载窗口经 BackupHost 注入；恢复只准备，替换数据库文件发生在下次启动打开数据库之前。
// ------------------------------------------------------------------------

import * as path from 'node:path';
import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { BackupFileInspection, DatabaseStatus, PendingRestore } from '../../domain/models/backup';
import { BackupStorage } from '../../domain/ports/backup-storage';
import { findBackupFileProblem, formatBackupTimestamp } from '../../domain/rules/backup-rules';

/** 备份文件的默认文件名前缀，后接时间戳。 */
const BACKUP_FILE_PREFIX = 'aigc-video-studio-backup-';

/** 备份文件的扩展名。 */
const BACKUP_FILE_EXTENSION = '.sqlite';

/** 备份功能需要的宿主能力，由扩展入口用 VS Code 接口实现。 */
export interface BackupHost {
  /** 让用户选择备份文件的保存位置；用户取消时返回 undefined。 */
  readonly pickBackupTarget: (suggestedName: string) => Promise<string | undefined>;
  /** 让用户选择要恢复的备份文件；用户取消时返回 undefined。 */
  readonly pickRestoreSource: () => Promise<string | undefined>;
  /** 重新加载窗口。 */
  readonly reloadWindow: () => Promise<void>;
}

/** 备份服务依赖的对象。 */
export interface BackupServiceDependencies {
  readonly storage: BackupStorage;
  readonly host: BackupHost;
  /** 当前扩展支持的最高数据库结构版本，即迁移的最大版本号。 */
  readonly latestSchemaVersion: number;
  /** 取当前时间，测试时可注入；缺省取系统时间。 */
  readonly now?: () => Date;
}

/** 备份页展示的概览。 */
export interface BackupOverview {
  /** 当前数据库的状态。 */
  readonly database: DatabaseStatus;
  /** 扩展支持的最高数据库结构版本，用于说明备份文件版本是否需要升级。 */
  readonly latestSchemaVersion: number;
  /** 已准备、重新加载窗口后生效的恢复；没有时为 null。 */
  readonly pendingRestore: PendingRestore | null;
}

/** 备份到文件的结果。 */
export type BackupExportResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly filePath: string; readonly sizeBytes: number };

/** 用户选中的备份文件。 */
export interface RestoreCandidate {
  /** 备份文件的绝对路径。 */
  readonly filePath: string;
  /** 备份文件的大小，单位为字节。 */
  readonly sizeBytes: number;
  /** 备份文件的数据库结构版本。 */
  readonly schemaVersion: number;
  /** 当前扩展支持的最高结构版本；备份版本低于它时，恢复后会自动升级。 */
  readonly latestSchemaVersion: number;
}

/** 选择备份文件的结果。 */
export type RestoreChoiceResult =
  | { readonly cancelled: true }
  | { readonly cancelled: false; readonly candidate: RestoreCandidate };

/** 数据备份服务。 */
export class BackupService {
  private readonly storage: BackupStorage;
  private readonly host: BackupHost;
  private readonly latestSchemaVersion: number;
  private readonly now: () => Date;
  /** 用户已选中并通过校验、等待确认恢复的备份文件路径；恢复路径只在宿主内保存，不由页面回传。 */
  private chosenRestorePath: string | undefined;

  constructor(dependencies: BackupServiceDependencies) {
    this.storage = dependencies.storage;
    this.host = dependencies.host;
    this.latestSchemaVersion = dependencies.latestSchemaVersion;
    this.now = dependencies.now ?? (() => new Date());
  }

  /** 读取页面展示的概览：数据库状态与待生效的恢复。 */
  getOverview(): BackupOverview {
    return {
      database: this.storage.readStatus(),
      latestSchemaVersion: this.latestSchemaVersion,
      pendingRestore: this.storage.readPendingRestore() ?? null
    };
  }

  /**
   * 让用户选择位置，把当前数据库备份为一个文件。
   * @returns 用户取消时 cancelled 为 true；否则返回备份文件路径与大小。
   * @throws ValidationError 选择的位置是当前正在使用的数据库文件。
   */
  async backup(): Promise<BackupExportResult> {
    const suggestedName = `${BACKUP_FILE_PREFIX}${formatBackupTimestamp(this.now())}${BACKUP_FILE_EXTENSION}`;
    const targetPath = await this.host.pickBackupTarget(suggestedName);
    if (targetPath === undefined) {
      return { cancelled: true };
    }
    // 备份目标不能是正在使用的数据库文件，否则会替换掉现有数据。
    if (isSameFile(targetPath, this.storage.databasePath)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '不能把备份保存为当前正在使用的数据库文件，请换一个位置。' });
    }
    const sizeBytes = this.storage.exportSnapshot(targetPath);
    return { cancelled: false, filePath: targetPath, sizeBytes };
  }

  /**
   * 让用户选择要恢复的备份文件并校验；通过后记住该文件，等待页面确认。
   * @returns 用户取消时 cancelled 为 true；否则返回备份文件的信息。
   * @throws ValidationError 文件不是本扩展的合法备份：无法读取、缺少核心表、版本高于当前扩展、已损坏。
   */
  async chooseRestoreFile(): Promise<RestoreChoiceResult> {
    const filePath = await this.host.pickRestoreSource();
    if (filePath === undefined) {
      return { cancelled: true };
    }
    const candidate = this.validateRestoreFile(filePath);
    this.chosenRestorePath = filePath;
    return { cancelled: false, candidate };
  }

  /**
   * 确认恢复：把已选中的备份文件准备为待恢复，重新加载窗口时才替换当前数据库，并先自动备份当前数据库。
   * @returns 准备好的待恢复信息。
   * @throws ValidationError 还没有选择备份文件，或备份文件已不再合法。
   */
  restore(): PendingRestore {
    if (this.chosenRestorePath === undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '请先选择要恢复的备份文件。' });
    }
    const filePath = this.chosenRestorePath;
    // 选择之后文件可能被改动，准备恢复前再校验一次。
    this.validateRestoreFile(filePath);
    this.storage.stageRestore(filePath);
    this.chosenRestorePath = undefined;
    const pending = this.storage.readPendingRestore();
    if (pending === undefined) {
      throw new Error('准备恢复后没有找到待恢复文件。');
    }
    return pending;
  }

  /** 放弃已准备的恢复，当前数据库保持不变。 */
  cancelRestore(): void {
    this.storage.discardPendingRestore();
  }

  /** 重新加载窗口，使已准备的恢复生效。 */
  async reloadWindow(): Promise<void> {
    await this.host.reloadWindow();
  }

  /** 读取并校验备份文件，返回其信息；不合法时抛出带原因的校验错误。 */
  private validateRestoreFile(filePath: string): RestoreCandidate {
    if (isSameFile(filePath, this.storage.databasePath)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '不能选择当前正在使用的数据库文件，请选择之前备份出来的文件。' });
    }
    let inspection: BackupFileInspection;
    try {
      inspection = this.storage.inspectFile(filePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `所选文件无法作为数据库读取：${reason}` });
    }
    const problem = findBackupFileProblem(inspection, this.latestSchemaVersion);
    if (problem !== undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: problem });
    }
    return {
      filePath,
      sizeBytes: inspection.sizeBytes,
      schemaVersion: inspection.schemaVersion,
      latestSchemaVersion: this.latestSchemaVersion
    };
  }
}

/** 判断两个路径是否指向同一个文件；Windows 的路径不区分大小写。 */
function isSameFile(first: string, second: string): boolean {
  const normalize = (value: string): string => (process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value));
  return normalize(first) === normalize(second);
}
