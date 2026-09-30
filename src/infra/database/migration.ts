// ------------------------------------------------------------------------
// 名称：migration.ts
// 说明：数据库迁移的类型定义与迁移错误。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：无
// ------------------------------------------------------------------------

/** 一个数据库迁移：把结构从 version - 1 升级到 version。 */
export interface Migration {
  /** 目标结构版本，从 1 开始连续递增。 */
  readonly version: number;
  /** 迁移名称，用于错误信息，如 `core`。 */
  readonly name: string;
  /** 升级用的 SQL，可含多条语句。 */
  readonly sql: string;
}

/** 迁移执行失败或迁移配置不合法时抛出。 */
export class MigrationError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}
