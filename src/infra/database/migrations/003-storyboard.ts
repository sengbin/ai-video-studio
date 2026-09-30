// ------------------------------------------------------------------------
// 名称：003-storyboard.ts
// 说明：迁移 3：分镜脚本、镜头、镜头出场实体和镜头声音。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：首帧来源为 asset 时必须有首帧图片，由业务层校验；不用 CHECK，避免删除资产文件时置空外键被拒绝。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const storyboardMigration: Migration = {
  version: 3,
  name: 'storyboard',
  sql: `
CREATE TABLE storyboard_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL UNIQUE REFERENCES stage_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX storyboard_scripts_episode_idx ON storyboard_scripts (episode_id);

CREATE TABLE shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyboard_script_id INTEGER NOT NULL REFERENCES storyboard_scripts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  scene_label TEXT NOT NULL DEFAULT '',
  shot_size TEXT NOT NULL DEFAULT '',
  camera_angle TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  camera_movement TEXT NOT NULL DEFAULT '',
  duration_seconds REAL NOT NULL CHECK (duration_seconds > 0),
  transition TEXT NOT NULL DEFAULT '',
  continuity_note TEXT NOT NULL DEFAULT '',
  first_frame_mode TEXT NOT NULL DEFAULT 'none' CHECK (first_frame_mode IN ('none', 'prev_tail', 'asset')),
  first_frame_asset_file_id INTEGER REFERENCES asset_files(id) ON DELETE SET NULL,
  prompt_zh TEXT NOT NULL DEFAULT '',
  prompt_en TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (storyboard_script_id, seq)
);

CREATE TABLE shot_entities (
  shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES script_entities(id) ON DELETE CASCADE,
  PRIMARY KEY (shot_id, entity_id)
);
CREATE INDEX shot_entities_entity_idx ON shot_entities (entity_id);

CREATE TABLE shot_sounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('dialogue', 'narration', 'sfx', 'music')),
  speaker_entity_id INTEGER REFERENCES script_entities(id) ON DELETE SET NULL,
  text TEXT NOT NULL,
  delivery TEXT NOT NULL DEFAULT '',
  start_offset_seconds REAL CHECK (start_offset_seconds IS NULL OR start_offset_seconds >= 0),
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  audio_asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  UNIQUE (shot_id, seq)
);
CREATE INDEX shot_sounds_speaker_idx ON shot_sounds (speaker_entity_id);
`
};
