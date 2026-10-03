// ------------------------------------------------------------------------
// 名称：index.ts
// 说明：汇总全部数据库迁移，按版本号升序排列。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：新增迁移时在数组末尾追加，版本号必须连续。
// ------------------------------------------------------------------------

import { Migration } from '../migration';
import { initialMigration } from './001-initial';

/** 全部数据库迁移，版本号从 1 开始连续递增。 */
export const MIGRATIONS: readonly Migration[] = [initialMigration];