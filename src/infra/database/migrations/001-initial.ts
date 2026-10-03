// ------------------------------------------------------------------------
// 名称：001-initial.ts
// 说明：迁移 1：初始数据库结构，包含项目、作品、阶段生成、资产、分镜、模型、生成参数、视频任务与作品文本模型等全部业务表。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：首次发布（0.1.0）的初始结构；已发布的迁移不再修改，之后的结构变更请新增下一个版本号的迁移，并保留用户数据。服务商密钥不入库，保存在 VS Code SecretStorage。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

/** 初始结构迁移：新库一次建出全部表、约束和索引。 */
export const initialMigration: Migration = {
  version: 1,
  name: 'initial',
  sql: `
-- 项目：组织作品的容器。
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

-- 作品：单个短视频或多集短片。
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

-- 作品的灵感来源文件（图片、小说文本）。
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

-- 集。
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

-- 阶段生成记录（创意、剧本、分镜脚本）：每次生成一个版本，经确认后成为当前版本。
CREATE TABLE stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  episode_id INTEGER REFERENCES episodes(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (stage IN ('creative', 'screenplay', 'storyboard_script')),
  version INTEGER NOT NULL CHECK (version >= 1),
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'canceled')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved')),
  is_current INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  source_run_id INTEGER REFERENCES stage_runs(id) ON DELETE SET NULL,
  source_revision INTEGER CHECK (source_revision IS NULL OR source_revision >= 1),
  model_info TEXT,
  progress_json TEXT CHECK (progress_json IS NULL OR json_valid(progress_json)),
  raw_output TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  approved_at TEXT,
  applied_at TEXT,
  CHECK ((stage = 'storyboard_script') = (episode_id IS NOT NULL)),
  CHECK (review_status = 'pending' OR status = 'succeeded'),
  CHECK (is_current = 0 OR (status = 'succeeded' AND review_status = 'approved'))
);
CREATE INDEX stage_runs_latest_idx ON stage_runs (work_id, stage, episode_id, version DESC);
-- 同一目标（作品、阶段、集）最多一个当前版本、最多一个运行中的记录。
CREATE UNIQUE INDEX stage_runs_current_unique_idx
  ON stage_runs (work_id, stage, ifnull(episode_id, 0)) WHERE is_current = 1;
CREATE UNIQUE INDEX stage_runs_running_unique_idx
  ON stage_runs (work_id, stage, ifnull(episode_id, 0)) WHERE status = 'running';
CREATE INDEX stage_runs_source_idx ON stage_runs (source_run_id);

-- 创意阶段产出的章节。
CREATE TABLE chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq BETWEEN 1 AND 100),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

-- 剧本阶段产出的剧本包。
CREATE TABLE screenplays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL UNIQUE REFERENCES stage_runs(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  overview TEXT NOT NULL,
  full_text TEXT NOT NULL,
  structure_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(structure_json)),
  updated_at TEXT NOT NULL
);

-- 剧本实体：角色、场景、道具、特效。
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

-- 服务商：密钥不入库。
CREATE TABLE providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 模型：按类型区分文本、图像、音频、视频。
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id INTEGER NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  display_name TEXT NOT NULL,
  is_enabled INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('text', 'image', 'audio', 'video')),
  created_at TEXT NOT NULL,
  UNIQUE (provider_id, code)
);

CREATE TABLE model_capabilities (
  model_id INTEGER PRIMARY KEY REFERENCES models(id) ON DELETE CASCADE,
  capability_json TEXT NOT NULL CHECK (json_valid(capability_json)),
  updated_at TEXT NOT NULL
);

-- 资产分类：属于某个资产类型，分类被删除时资产变为未分类。
CREATE TABLE asset_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'effect', 'audio')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, name)
);

-- 资产：全部项目共用。content_revision 随内容修改递增，prompt_content_revision 记录提示词基于哪一版内容；file_source 为当前使用的文件来源。
CREATE TABLE assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'effect', 'audio')),
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES asset_categories(id) ON DELETE SET NULL,
  source_entity_id INTEGER REFERENCES script_entities(id) ON DELETE SET NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  composition TEXT NOT NULL DEFAULT '',
  style TEXT,
  background TEXT NOT NULL DEFAULT '',
  reference_aspect_ratio TEXT,
  extra_requirements TEXT NOT NULL DEFAULT '',
  prompt_zh TEXT NOT NULL DEFAULT '',
  prompt_en TEXT NOT NULL DEFAULT '',
  content_revision INTEGER NOT NULL DEFAULT 1,
  prompt_revision INTEGER NOT NULL DEFAULT 0,
  prompt_content_revision INTEGER NOT NULL DEFAULT 0,
  prompt_status TEXT NOT NULL DEFAULT 'none'
    CHECK (prompt_status IN ('none', 'running', 'succeeded', 'failed', 'canceled')),
  prompt_error TEXT,
  adopted_version_id INTEGER REFERENCES asset_versions(id) ON DELETE SET NULL,
  file_source TEXT NOT NULL DEFAULT 'generated' CHECK (file_source IN ('upload', 'generated')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, name)
);
CREATE INDEX assets_category_idx ON assets (category_id);

-- 资产文件：内容保存在磁盘，表里只记录相对路径。
CREATE TABLE asset_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'reference' CHECK (role IN ('reference', 'thumbnail')),
  source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'generated')),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN (
    'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/mp4'
  )),
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX asset_files_asset_role_idx ON asset_files (asset_id, role, sort_order);
CREATE INDEX asset_files_path_idx ON asset_files (file_path);

-- 资产生成版本：每次图像、音频生成一条；同一资产同时只能有一个进行中的版本。
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
  file_path TEXT NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN (
    'image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav', 'audio/mp4'
  )),
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_adopted INTEGER NOT NULL DEFAULT 0 CHECK (is_adopted IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX asset_version_files_version_role_idx ON asset_version_files (version_id, role, sort_order);
CREATE INDEX asset_version_files_path_idx ON asset_version_files (file_path);

-- 实体绑定：把集内的剧本实体关联到资产，同一实体同一用途只能有一个主资产。
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

-- 分镜脚本。
CREATE TABLE storyboard_scripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  episode_id INTEGER NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  run_id INTEGER NOT NULL UNIQUE REFERENCES stage_runs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX storyboard_scripts_episode_idx ON storyboard_scripts (episode_id);

-- 镜头组：相邻镜头打包，一组一次生成一个多镜头视频。
CREATE TABLE shot_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyboard_script_id INTEGER NOT NULL REFERENCES storyboard_scripts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (storyboard_script_id, seq)
);

-- 镜头：首帧来源为 asset 时必须有首帧资产，由业务层校验；不用 CHECK，避免删除资产时置空外键被拒绝。
CREATE TABLE shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyboard_script_id INTEGER NOT NULL REFERENCES storyboard_scripts(id) ON DELETE CASCADE,
  group_id INTEGER REFERENCES shot_groups(id) ON DELETE SET NULL,
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
  first_frame_asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  prompt_zh TEXT NOT NULL DEFAULT '',
  prompt_en TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (storyboard_script_id, seq)
);
CREATE INDEX shots_group_idx ON shots (group_id);

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

-- 生成参数：按作品、集、镜头组三级覆盖，空值表示沿用上一级；负向清单的空串表示明确不要负向清单，提示词改写 0 关闭、1 开启。
CREATE TABLE generation_profiles (
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
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  audio_mode TEXT CHECK (audio_mode IS NULL OR audio_mode IN ('none', 'native')),
  audio_elements_json TEXT CHECK (audio_elements_json IS NULL OR json_valid(audio_elements_json)),
  seed INTEGER,
  negative_list TEXT,
  prompt_extend INTEGER CHECK (prompt_extend IS NULL OR prompt_extend IN (0, 1)),
  extra_params_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(extra_params_json)),
  updated_at TEXT NOT NULL,
  CHECK (min_shot_seconds IS NULL OR max_shot_seconds IS NULL OR min_shot_seconds <= max_shot_seconds),
  CHECK (
    (scope = 'work' AND work_id IS NOT NULL AND episode_id IS NULL AND group_id IS NULL) OR
    (scope = 'episode' AND episode_id IS NOT NULL AND work_id IS NULL AND group_id IS NULL) OR
    (scope = 'group' AND group_id IS NOT NULL AND work_id IS NULL AND episode_id IS NULL)
  )
);
CREATE UNIQUE INDEX generation_profiles_work_unique_idx ON generation_profiles (work_id) WHERE scope = 'work';
CREATE UNIQUE INDEX generation_profiles_episode_unique_idx ON generation_profiles (episode_id) WHERE scope = 'episode';
CREATE UNIQUE INDEX generation_profiles_group_unique_idx ON generation_profiles (group_id) WHERE scope = 'group';

-- 视频生成任务：只在提交时创建；每个镜头组最多一个进行中的任务，提交时的检查与插入再并发也不会产生第二个。
CREATE TABLE video_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES shot_groups(id) ON DELETE CASCADE,
  model_id INTEGER NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('waiting', 'queued', 'running', 'succeeded', 'failed', 'canceled')),
  request_snapshot_json TEXT NOT NULL CHECK (json_valid(request_snapshot_json)),
  remote_job_id TEXT,
  error_category TEXT CHECK (error_category IS NULL OR error_category IN (
    'auth', 'rate_limited', 'invalid_request', 'content_rejected', 'server', 'network'
  )),
  error_code TEXT,
  error_message TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  prev_job_id INTEGER REFERENCES video_jobs(id) ON DELETE SET NULL,
  first_frame_id INTEGER REFERENCES result_frames(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  submitted_at TEXT,
  finished_at TEXT,
  CHECK (status = 'failed' OR error_category IS NULL)
);
CREATE INDEX video_jobs_group_created_idx ON video_jobs (group_id, created_at DESC);
CREATE INDEX video_jobs_status_idx ON video_jobs (status);
CREATE INDEX video_jobs_prev_job_idx ON video_jobs (prev_job_id);
CREATE UNIQUE INDEX video_jobs_active_group_unique_idx
  ON video_jobs (group_id) WHERE status IN ('waiting', 'queued', 'running');

CREATE TABLE video_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES shot_groups(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  remote_url TEXT,
  remote_expires_at TEXT,
  duration_seconds REAL CHECK (duration_seconds IS NULL OR duration_seconds > 0),
  width INTEGER,
  height INTEGER,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  has_audio INTEGER NOT NULL DEFAULT 0 CHECK (has_audio IN (0, 1)),
  is_selected INTEGER NOT NULL DEFAULT 0 CHECK (is_selected IN (0, 1)),
  created_at TEXT NOT NULL
);
CREATE INDEX video_results_job_idx ON video_results (job_id);
CREATE UNIQUE INDEX video_results_selected_unique_idx ON video_results (group_id) WHERE is_selected = 1;

-- 结果视频的尾帧图片，供下一组作首帧。
CREATE TABLE result_frames (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  result_id INTEGER NOT NULL REFERENCES video_results(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'tail' CHECK (kind IN ('tail')),
  mime TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX result_frames_result_idx ON result_frames (result_id);

-- 作品单独选择的文本模型；没有记录表示沿用全局默认文本模型。
CREATE TABLE work_text_models (
  work_id INTEGER PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
  model_key TEXT NOT NULL CHECK (length(model_key) > 0),
  updated_at TEXT NOT NULL
);
`
};
