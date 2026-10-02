// ------------------------------------------------------------------------
// 名称：010-global-assets.ts
// 说明：迁移 10：资产不再属于项目，全部项目共用；名称唯一范围由（项目，类型，名称）改为（类型，名称）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：重名的资产保留最早的一个，其余在名称后加（项目名）；原来沿用项目风格（style 为空）的图像资产把项目风格写入 style，保持提示词不变。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const globalAssetsMigration: Migration = {
  version: 10,
  name: 'global-assets',
  rebuildsReferencedTables: true,
  sql: `
CREATE TABLE assets_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'effect', 'audio')),
  name TEXT NOT NULL,
  source_entity_id INTEGER REFERENCES script_entities(id) ON DELETE SET NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  composition TEXT NOT NULL DEFAULT '',
  style TEXT,
  background TEXT NOT NULL DEFAULT '',
  reference_aspect_ratio TEXT,
  extra_requirements TEXT NOT NULL DEFAULT '',
  prompt_zh TEXT NOT NULL DEFAULT '',
  prompt_en TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_revision INTEGER NOT NULL DEFAULT 1,
  prompt_revision INTEGER NOT NULL DEFAULT 0,
  prompt_content_revision INTEGER NOT NULL DEFAULT 0,
  prompt_status TEXT NOT NULL DEFAULT 'none'
    CHECK (prompt_status IN ('none', 'running', 'succeeded', 'failed', 'canceled')),
  prompt_error TEXT,
  adopted_version_id INTEGER REFERENCES asset_versions(id) ON DELETE SET NULL,
  UNIQUE (kind, name)
);

INSERT INTO assets_new (
  id, kind, name, source_entity_id, attributes_json, composition, style, background, reference_aspect_ratio,
  extra_requirements, prompt_zh, prompt_en, created_at, updated_at, content_revision, prompt_revision,
  prompt_content_revision, prompt_status, prompt_error, adopted_version_id
)
SELECT
  a.id, a.kind,
  CASE WHEN EXISTS (SELECT 1 FROM assets b WHERE b.kind = a.kind AND b.name = a.name AND b.id < a.id)
       THEN a.name || '（' || p.name || '）' ELSE a.name END,
  a.source_entity_id, a.attributes_json, a.composition,
  CASE WHEN a.kind <> 'audio' AND a.style IS NULL THEN p.visual_style ELSE a.style END,
  a.background, a.reference_aspect_ratio, a.extra_requirements, a.prompt_zh, a.prompt_en, a.created_at, a.updated_at,
  a.content_revision, a.prompt_revision, a.prompt_content_revision, a.prompt_status, a.prompt_error, a.adopted_version_id
FROM assets a JOIN projects p ON p.id = a.project_id;

DROP TABLE assets;
ALTER TABLE assets_new RENAME TO assets;
`
};
