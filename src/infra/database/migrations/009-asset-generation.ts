// ------------------------------------------------------------------------
// 名称：009-asset-generation.ts
// 说明：迁移 9：资产的修订号、提示词后台生成状态、采用版本，以及图片、音频生成版本表与版本文件表。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：字段含义见 docs/database-design.md 4.9；已有资产的修订号取默认值，已有提示词视为基于当前内容。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const assetGenerationMigration: Migration = {
  version: 9,
  name: 'asset-generation',
  sql: `
CREATE TABLE asset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json)),
  content_revision INTEGER NOT NULL,
  prompt_revision INTEGER NOT NULL,
  remote_job_id TEXT,
  error_category TEXT CHECK (error_category IS NULL OR error_category IN (
    'auth', 'rate_limited', 'invalid_request', 'content_rejected', 'server', 'network'
  )),
  error_code TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  finished_at TEXT,
  UNIQUE (asset_id, version),
  CHECK (status = 'failed' OR error_category IS NULL)
);
CREATE INDEX asset_versions_status_idx ON asset_versions (status);
CREATE UNIQUE INDEX asset_versions_active_unique_idx
  ON asset_versions (asset_id) WHERE status IN ('queued', 'running');

CREATE TABLE asset_version_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL REFERENCES asset_versions(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'result' CHECK (role IN ('result', 'thumbnail')),
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
  is_adopted INTEGER NOT NULL DEFAULT 0 CHECK (is_adopted IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX asset_version_files_version_role_idx ON asset_version_files (version_id, role, sort_order);

ALTER TABLE assets ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN prompt_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN prompt_content_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN prompt_status TEXT NOT NULL DEFAULT 'none'
  CHECK (prompt_status IN ('none', 'running', 'succeeded', 'failed', 'canceled'));
ALTER TABLE assets ADD COLUMN prompt_error TEXT;
ALTER TABLE assets ADD COLUMN adopted_version_id INTEGER REFERENCES asset_versions(id) ON DELETE SET NULL;

UPDATE assets
   SET prompt_revision = 1, prompt_content_revision = 1
 WHERE prompt_zh <> '' OR prompt_en <> '';
`
};
