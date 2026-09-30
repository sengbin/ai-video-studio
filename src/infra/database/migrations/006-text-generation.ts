// ------------------------------------------------------------------------
// 名称：006-text-generation.ts
// 说明：迁移 6：阶段记录增加人工确认、修订与进度字段，剧本包增加结构快照，模型增加类型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：测试阶段允许丢弃数据：重建 stage_runs 会级联清除章节、剧本包、分镜脚本及其下游镜头与生成任务。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const textGenerationMigration: Migration = {
  version: 6,
  name: 'text-generation',
  sql: `
-- 修改 status 的 CHECK 需要重建表；外键已启用，删表时其下游数据随级联一并清除，重建后按表名自动重新关联。
DROP TABLE stage_runs;

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
CREATE UNIQUE INDEX stage_runs_current_unique_idx
  ON stage_runs (work_id, stage, ifnull(episode_id, 0)) WHERE is_current = 1;
CREATE UNIQUE INDEX stage_runs_running_unique_idx
  ON stage_runs (work_id, stage, ifnull(episode_id, 0)) WHERE status = 'running';
CREATE INDEX stage_runs_source_idx ON stage_runs (source_run_id);

ALTER TABLE screenplays ADD COLUMN structure_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(structure_json));

ALTER TABLE models ADD COLUMN kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('image', 'audio', 'video'));
`
};
