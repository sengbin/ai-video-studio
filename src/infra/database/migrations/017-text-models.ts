// ------------------------------------------------------------------------
// 名称：017-text-models.ts
// 说明：迁移 017：重建 models，模型类型新增“文本”（text），用于接入千问AI平台的文本生成模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：已发布版本之后的结构变更必须保留数据：全部行原样搬迁，标识不变；models 被生成任务、生成参数、能力描述等表引用，因此需要关闭外键执行并在结束后检查完整性。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const textModelsMigration: Migration = {
  version: 17,
  name: 'text-models',
  rebuildsReferencedTables: true,
  sql: `
CREATE TABLE models_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('text', 'image', 'audio', 'video')),
  UNIQUE (provider_id, code)
);

INSERT INTO models_new (id, provider_id, code, display_name, is_enabled, created_at, kind)
SELECT id, provider_id, code, display_name, is_enabled, created_at, kind FROM models;

DROP TABLE models;
ALTER TABLE models_new RENAME TO models;
`
};
