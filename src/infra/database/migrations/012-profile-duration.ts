// ------------------------------------------------------------------------
// 名称：012-profile-duration.ts
// 说明：迁移 012：生成参数新增“生成时长”，用于镜头组指定整组视频的时长。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：种子（seed）、声音内容（audio_elements_json）早在迁移 004 已预留，本迁移只补时长列；已有行的时长为空，表示沿用“按镜头总时长向上对齐”的原有行为。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const profileDurationMigration: Migration = {
  version: 12,
  name: 'profile-duration',
  sql: `
ALTER TABLE generation_profiles ADD COLUMN duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds > 0);
`
};
