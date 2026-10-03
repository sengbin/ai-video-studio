// ------------------------------------------------------------------------
// 名称：014-audio-mode-cleanup.ts
// 说明：迁移 014：重建 generation_profiles，声音模式只允许“无声”和“模型原生生成”，去掉已取消的“独立音轨”取值。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：已发布版本之后的结构变更必须保留数据：全部行原样搬迁，从未被程序写入过的 external 取值转为空（沿用上一级）；generation_profiles 不被其他表引用，不需要关闭外键。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const audioModeCleanupMigration: Migration = {
  version: 14,
  name: 'audio-mode-cleanup',
  sql: `
CREATE TABLE generation_profiles_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CHECK (scope IN ('work', 'episode', 'group')),
  work_id INTEGER REFERENCES works(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES shot_groups(id) ON DELETE CASCADE,
  model_id INTEGER REFERENCES models(id) ON DELETE RESTRICT,
  aspect_ratio TEXT,
  resolution TEXT,
  min_shot_seconds REAL CHECK (min_shot_seconds IS NULL OR min_shot_seconds > 0),
  max_shot_seconds REAL CHECK (max_shot_seconds IS NULL OR max_shot_seconds > 0),
  audio_mode TEXT CHECK (audio_mode IS NULL OR audio_mode IN ('none', 'native')),
  audio_elements_json TEXT CHECK (audio_elements_json IS NULL OR json_valid(audio_elements_json)),
  seed INTEGER,
  extra_params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_params_json)),
  updated_at TEXT NOT NULL,
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  CHECK (min_shot_seconds IS NULL OR max_shot_seconds IS NULL OR min_shot_seconds <= max_shot_seconds),
  CHECK (
    (scope = 'work' AND work_id IS NOT NULL AND episode_id IS NULL AND group_id IS NULL) OR
    (scope = 'episode' AND episode_id IS NOT NULL AND work_id IS NULL AND group_id IS NULL) OR
    (scope = 'group' AND group_id IS NOT NULL AND work_id IS NULL AND episode_id IS NULL)
  )
);

INSERT INTO generation_profiles_new (
  id, scope, work_id, episode_id, group_id, model_id, aspect_ratio, resolution, min_shot_seconds, max_shot_seconds,
  audio_mode, audio_elements_json, seed, extra_params_json, updated_at, duration_seconds
)
SELECT
  id, scope, work_id, episode_id, group_id, model_id, aspect_ratio, resolution, min_shot_seconds, max_shot_seconds,
  CASE WHEN audio_mode = 'external' THEN NULL ELSE audio_mode END,
  audio_elements_json, seed, extra_params_json, updated_at, duration_seconds
FROM generation_profiles;

DROP TABLE generation_profiles;
ALTER TABLE generation_profiles_new RENAME TO generation_profiles;

CREATE UNIQUE INDEX generation_profiles_work_unique_idx ON generation_profiles (work_id) WHERE scope = 'work';
CREATE UNIQUE INDEX generation_profiles_episode_unique_idx ON generation_profiles (episode_id) WHERE scope = 'episode';
CREATE UNIQUE INDEX generation_profiles_group_unique_idx ON generation_profiles (group_id) WHERE scope = 'group';
`
};
