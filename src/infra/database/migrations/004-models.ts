// ------------------------------------------------------------------------
// 名称：004-models.ts
// 说明：迁移 4：模型服务商、模型、模型能力和三级生成参数。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：服务商密钥不入库，保存在 VS Code SecretStorage。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const modelsMigration: Migration = {
  version: 4,
  name: 'models',
  sql: `
CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (provider_id, code)
);

CREATE TABLE model_capabilities (
  model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  capability_json TEXT NOT NULL CHECK (json_valid(capability_json)),
  updated_at TEXT NOT NULL
);

CREATE TABLE generation_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('work', 'episode', 'shot')),
  work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  shot_id INTEGER REFERENCES shots(id) ON DELETE CASCADE,
  model_id INTEGER REFERENCES models(id) ON DELETE RESTRICT,
  aspect_ratio TEXT,
  resolution TEXT,
  min_shot_seconds REAL CHECK (min_shot_seconds IS NULL OR min_shot_seconds > 0),
  max_shot_seconds REAL CHECK (max_shot_seconds IS NULL OR max_shot_seconds > 0),
  audio_mode TEXT CHECK (audio_mode IS NULL OR audio_mode IN ('none', 'native', 'external')),
  audio_elements_json TEXT CHECK (audio_elements_json IS NULL OR json_valid(audio_elements_json)),
  seed INTEGER,
  extra_params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_params_json)),
  updated_at TEXT NOT NULL,
  CHECK (min_shot_seconds IS NULL OR max_shot_seconds IS NULL OR min_shot_seconds <= max_shot_seconds),
  CHECK (
    (scope = 'work' AND work_id IS NOT NULL AND episode_id IS NULL AND shot_id IS NULL) OR
    (scope = 'episode' AND episode_id IS NOT NULL AND work_id IS NULL AND shot_id IS NULL) OR
    (scope = 'shot' AND shot_id IS NOT NULL AND work_id IS NULL AND episode_id IS NULL)
  )
);
CREATE UNIQUE INDEX generation_profiles_work_unique_idx ON generation_profiles (work_id) WHERE scope = 'work';
CREATE UNIQUE INDEX generation_profiles_episode_unique_idx ON generation_profiles (episode_id) WHERE scope = 'episode';
CREATE UNIQUE INDEX generation_profiles_shot_unique_idx ON generation_profiles (shot_id) WHERE scope = 'shot';
`
};
