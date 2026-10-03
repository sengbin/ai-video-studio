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

/** 已准备好、重新加载窗口后生效的恢复。 */
export interface PendingRestore {
  /** 待恢复数据库的大小，单位为字节。 */
  readonly sizeBytes: number;
  /** 准备恢复的时间，ISO 8601 字符串。 */
  readonly stagedAt: string;
  /** 待恢复项的标识，由待恢复文件的修改时间与大小得出；取消恢复时带回，用来确认取消的就是页面看到的那一项。 */
  readonly token: string;
}
