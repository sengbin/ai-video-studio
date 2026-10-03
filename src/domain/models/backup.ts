// ------------------------------------------------------------------------
// 名称：backup.ts
// 说明：数据备份相关的领域模型：数据库当前状态与各类数据数量、备份文件的检查结果、待生效的恢复。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：只描述数据，不含读写逻辑；日期用 ISO 8601 字符串，便于直接发给页面。
// ------------------------------------------------------------------------

/** 数据库中各类数据的数量，页面据此展示数据量。 */
export interface BackupDataCounts {
  /** 项目数。 */
  readonly projects: number;
  /** 作品数。 */
  readonly works: number;
  /** 集数。 */
  readonly episodes: number;
  /** 资产数。 */
  readonly assets: number;
  /** 镜头数。 */
  readonly shots: number;
  /** 视频结果数；结果视频文件本身保存在数据库之外，不在备份内。 */
  readonly videoResults: number;
}

/** 当前正在使用的数据库的状态。 */
export interface DatabaseStatus {
  /** 数据库文件的绝对路径。 */
  readonly databasePath: string;
  /** 数据库文件大小，单位为字节。 */
  readonly sizeBytes: number;
  /** 数据库的结构版本号（PRAGMA user_version）。 */
  readonly schemaVersion: number;
  /** 各类数据的数量。 */
  readonly counts: BackupDataCounts;
  /** 结果视频文件所在的目录，不包含在备份中。 */
  readonly resultVideoDirectory: string;
  /** 资产图片、音频文件所在的目录；备份时数据库引用的文件会复制到备份文件旁的同名文件夹，恢复时从那里补回。 */
  readonly assetFileDirectory: string;
}

/** 对一个待恢复备份文件的检查结果，由基础设施层读取文件得到，是否合法由领域规则判断。 */
export interface BackupFileInspection {
  /** 文件大小，单位为字节。 */
  readonly sizeBytes: number;
  /** 文件中的结构版本号（PRAGMA user_version）。 */
  readonly schemaVersion: number;
  /** 文件中已有的数据表名。 */
  readonly tableNames: readonly string[];
  /** 完整性检查（PRAGMA quick_check）的结果：通过为 'ok'，否则为第一条问题描述。 */
  readonly integrity: string;
}

/** 备份时复制资产文件的结果。 */
export interface BackupAssetFileExport {
  /** 备份文件旁存放资产文件的文件夹（备份文件名 + `.files`）。 */
  readonly directory: string;
  /** 已复制的文件数。 */
  readonly fileCount: number;
  /** 已复制文件的总大小，单位为字节。 */
  readonly sizeBytes: number;
  /** 数据库引用但磁盘上找不到、没能复制的文件数。 */
  readonly missingCount: number;
}

/** 对备份文件所引用资产文件的检查结果。 */
export interface BackupAssetFileInspection {
  /** 备份文件旁存放资产文件的文件夹（备份文件名 + `.files`），不一定存在。 */
  readonly directory: string;
  /** 备份数据库引用的资产文件数。 */
  readonly referencedCount: number;
  /** 其中在备份文件夹或当前资产文件目录里能找到的文件数；少于引用数时，恢复后有图片、音频无法显示。 */
  readonly availableCount: number;
}

/** 已准备好、重新加载窗口后生效的恢复。 */
export interface PendingRestore {
  /** 待恢复数据库的大小，单位为字节。 */
  readonly sizeBytes: number;
  /** 准备恢复的时间，ISO 8601 字符串。 */
  readonly stagedAt: string;
  /** 待恢复项的标识，由待恢复文件的修改时间与大小得出；取消恢复时带回，用来确认取消的就是页面看到的那一项。 */
  readonly token: string;
}
