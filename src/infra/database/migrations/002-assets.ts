// ------------------------------------------------------------------------
// 名称：002-assets.ts
// 说明：迁移 2：项目资产、资产文件以及集内实体与资产的绑定。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：已发布的迁移不再修改；结构变更请新增下一个版本号的迁移。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const assetsMigration: Migration = {
  version: 2,
  name: 'assets',
  sql: `
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
  UNIQUE (project_id, kind, name)
);

CREATE TABLE asset_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'reference' CHECK (role IN ('reference', 'thumbnail')),
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN (
    'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/mp4'
  )),
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content BLOB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX asset_files_asset_role_idx ON asset_files (asset_id, role, sort_order);

CREATE TABLE entity_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES script_entities(id) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'visual' CHECK (purpose IN ('visual', 'voice')),
  is_primary INTEGER NOT NULL DEFAULT 1 CHECK (is_primary IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (episode_id, entity_id, asset_id)
);
CREATE UNIQUE INDEX entity_bindings_primary_unique_idx
  ON entity_bindings (episode_id, entity_id, purpose) WHERE is_primary = 1;
`
};
