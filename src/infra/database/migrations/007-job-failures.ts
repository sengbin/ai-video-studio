// ------------------------------------------------------------------------
// 名称：007-job-failures.ts
// 说明：迁移 7：重建生成任务相关表——失败分类与服务商分类一致并增加错误码，结果视频的宽高允许为空。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：测试阶段允许丢弃数据：重建 video_jobs 会连同 video_results、result_frames 一并清除。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const jobFailuresMigration: Migration = {
  version: 7,
  name: 'job-failures',
  sql: `
-- 修改 CHECK 约束需要重建表；先删下游表，再删 video_jobs。
DROP TABLE result_frames;
DROP TABLE video_results;
DROP TABLE video_jobs;

CREATE TABLE video_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
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
CREATE INDEX video_jobs_shot_created_idx ON video_jobs (shot_id, created_at DESC);
CREATE INDEX video_jobs_status_idx ON video_jobs (status);
CREATE INDEX video_jobs_prev_job_idx ON video_jobs (prev_job_id);

CREATE TABLE video_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES video_jobs(id) ON DELETE CASCADE,
  shot_id INTEGER NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
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
CREATE UNIQUE INDEX video_results_selected_unique_idx ON video_results (shot_id) WHERE is_selected = 1;

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
