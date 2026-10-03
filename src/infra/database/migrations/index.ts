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
import { globalAssetsMigration } from './010-global-assets';
import { groupProfilesMigration } from './011-group-profiles';
import { profileDurationMigration } from './012-profile-duration';
import { assetCategoriesMigration } from './013-asset-categories';
import { audioModeCleanupMigration } from './014-audio-mode-cleanup';
import { shotFirstFrameAssetMigration } from './015-shot-first-frame-asset';
import { promptParamsMigration } from './016-prompt-params';
import { textModelsMigration } from './017-text-models';
import { workTextModelsMigration } from './018-work-text-models';

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
  assetGenerationMigration,
  globalAssetsMigration,
  groupProfilesMigration,
  profileDurationMigration,
  assetCategoriesMigration,
  audioModeCleanupMigration,
  shotFirstFrameAssetMigration,
  promptParamsMigration,
  textModelsMigration,
  workTextModelsMigration
];
