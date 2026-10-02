// ------------------------------------------------------------------------
// 名称：008-shot-groups.ts
// 说明：迁移 8：新增镜头组，生成任务、结果视频改为挂在镜头组上（一组一次生成一个多镜头视频）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：测试阶段允许丢弃数据：重建 video_jobs 会连同 video_results、result_frames 一并清除；已有镜头的 group_id 为空，由应用在读取时补建分组。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const shotGroupsMigration: Migration = {
  version: 8,
  name: 'shot-groups',
  sql: `
DROP TABLE result_frames;
DROP TABLE video_results;
DROP TABLE video_jobs;

CREATE TABLE shot_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  storyboard_script_id INTEGER NOT NULL REFERENCES storyboard_scripts(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  created_at TEXT NOT NULL,
  UNIQUE (storyboard_script_id, seq)
);

ALTER TABLE shots ADD COLUMN group_id INTEGER REFERENCES shot_groups(id) ON DELETE SET NULL;
CREATE INDEX shots_group_idx ON shots (group_id);

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
`
};
