// ------------------------------------------------------------------------
// 名称：001-core.ts
// 说明：迁移 1：项目、作品、集、阶段生成记录、章节、剧本包和脚本实体。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：已发布的迁移不再修改；结构变更请新增下一个版本号的迁移。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const coreMigration: Migration = {
  version: 1,
  name: 'core',
  sql: `
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  visual_style TEXT,
  default_aspect_ratio TEXT,
  default_resolution TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE works (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('single', 'series')),
  source_type TEXT CHECK (source_type IS NULL OR source_type IN ('text', 'image', 'novel')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE work_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'novel_text')),
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content BLOB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX work_sources_work_order_idx ON work_sources (work_id, sort_order);

CREATE TABLE episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  title TEXT NOT NULL,
  synopsis TEXT NOT NULL DEFAULT '',
  screenplay_text TEXT NOT NULL DEFAULT '',
  target_duration_seconds INTEGER CHECK (target_duration_seconds IS NULL OR target_duration_seconds > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, seq)
);

CREATE TABLE stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('creative', 'screenplay', 'storyboard_script')),
  version INTEGER NOT NULL CHECK (version >= 1),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  error_message TEXT,
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  CHECK ((stage = 'storyboard_script') = (episode_id IS NOT NULL))
);
CREATE INDEX stage_runs_latest_idx ON stage_runs (work_id, stage, episode_id, version DESC);
CREATE UNIQUE INDEX stage_runs_current_unique_idx
  ON stage_runs (work_id, stage, ifnull(episode_id, 0)) WHERE is_current = 1;

CREATE TABLE chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 100),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE TABLE screenplays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL UNIQUE REFERENCES stage_runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  overview TEXT NOT NULL,
  full_text TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE script_entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'effect')),
  name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases_json)),
  description TEXT NOT NULL DEFAULT '',
  attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, kind, name)
);
`
};
