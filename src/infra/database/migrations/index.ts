// ------------------------------------------------------------------------
// 名称：index.ts
// 说明：汇总全部数据库迁移，按版本号升序排列。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：新增迁移时在数组末尾追加，版本号必须连续。
// ------------------------------------------------------------------------

import { Migration } from '../migration';
import { coreMigration } from './001-core';
import { assetsMigration } from './002-assets';
import { storyboardMigration } from './003-storyboard';
import { modelsMigration } from './004-models';
import { generationMigration } from './005-generation';
import { textGenerationMigration } from './006-text-generation';
import { jobFailuresMigration } from './007-job-failures';
import { shotGroupsMigration } from './008-shot-groups';
import { assetGenerationMigration } from './009-asset-generation';

/** 全部数据库迁移，版本号从 1 开始连续递增。 */
export const MIGRATIONS: readonly Migration[] = [
  coreMigration,
  assetsMigration,
  storyboardMigration,
  modelsMigration,
  generationMigration,
  textGenerationMigration,
  jobFailuresMigration,
  shotGroupsMigration,
  assetGenerationMigration
];
