// ------------------------------------------------------------------------
// 名称：018-work-text-models.ts
// 说明：迁移 018：新增 work_text_models，保存作品单独选择的文本模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：只新增表，已有数据不变；没有记录表示沿用全局默认文本模型；作品被删除时记录随之级联删除。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const workTextModelsMigration: Migration = {
  version: 18,
  name: 'work-text-models',
  sql: `
CREATE TABLE work_text_models (
  work_id INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL CHECK (length(model_key) > 0),
  updated_at TEXT NOT NULL
);
`
};
