// ------------------------------------------------------------------------
// 名称：011-group-profiles.ts
// 说明：迁移 011：生成参数增加“镜头组”级覆盖。重建 generation_profiles：范围由作品、集、镜头改为作品、集、镜头组，镜头级参数（从未写入）去掉，新增 group_id。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：视频按镜头组生成，所以参数覆盖的最小单位是镜头组；镜头组被删除（如重新分组）时它的覆盖随之清除；原有作品级、集级记录原样保留。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const groupProfilesMigration: Migration = {
  version: 11,
  name: 'group-profiles',
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
  audio_mode TEXT CHECK (audio_mode IS NULL OR audio_mode IN ('none', 'native', 'external')),
  audio_elements_json TEXT CHECK (audio_elements_json IS NULL OR json_valid(audio_elements_json)),
  seed INTEGER,
  extra_params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_params_json)),
  updated_at TEXT NOT NULL,
  CHECK (min_shot_seconds IS NULL OR max_shot_seconds IS NULL OR min_shot_seconds <= max_shot_seconds),
  CHECK (
    (scope = 'work' AND work_id IS NOT NULL AND episode_id IS NULL AND group_id IS NULL) OR
    (scope = 'episode' AND episode_id IS NOT NULL AND work_id IS NULL AND group_id IS NULL) OR
    (scope = 'group' AND group_id IS NOT NULL AND work_id IS NULL AND episode_id IS NULL)
  )
);

INSERT INTO generation_profiles_new (
  id, scope, work_id, episode_id, model_id, aspect_ratio, resolution, min_shot_seconds, max_shot_seconds,
  audio_mode, audio_elements_json, seed, extra_params_json, updated_at
)
SELECT
  id, scope, work_id, episode_id, model_id, aspect_ratio, resolution, min_shot_seconds, max_shot_seconds,
  audio_mode, audio_elements_json, seed, extra_params_json, updated_at
FROM generation_profiles
WHERE scope IN ('work', 'episode');

DROP TABLE generation_profiles;
ALTER TABLE generation_profiles_new RENAME TO generation_profiles;

CREATE UNIQUE INDEX generation_profiles_work_unique_idx ON generation_profiles (work_id) WHERE scope = 'work';
CREATE UNIQUE INDEX generation_profiles_episode_unique_idx ON generation_profiles (episode_id) WHERE scope = 'episode';
CREATE UNIQUE INDEX generation_profiles_group_unique_idx ON generation_profiles (group_id) WHERE scope = 'group';
`
};