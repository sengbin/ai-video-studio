// ------------------------------------------------------------------------
// 名称：019-active-job-unique.ts
// 说明：迁移 019：限制同一镜头组同时只能有一个进行中（waiting、queued、running）的视频任务。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不丢弃数据：存量数据中同一镜头组若已有多个进行中的任务，保留最新的一个（id 最大），其余改为失败并写明原因，再建部分唯一索引；被置为失败的任务不会再被队列处理，其后依赖它的等待任务由队列按“前序失败”一并失败。
// ------------------------------------------------------------------------

import { Migration } from '../migration';

export const activeJobUniqueMigration: Migration = {
  version: 19,
  name: 'active-job-unique',
  sql: `
-- 同一镜头组有多个进行中任务时，保留 id 最大（最新）的一个，其余记为失败；error_category 取 CHECK 约束允许的 invalid_request。
UPDATE video_jobs
   SET status = 'failed',
       error_category = 'invalid_request',
       error_code = 'DuplicateActiveJob',
       error_message = '升级数据库时发现同一镜头组有多个进行中的任务，已保留最新的一个，这个任务被自动结束。如果平台上仍有对应任务，请到平台确认是否已产生计费。',
       finished_at = COALESCE(finished_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
 WHERE status IN ('waiting', 'queued', 'running')
   AND EXISTS (
     SELECT 1 FROM video_jobs newer
      WHERE newer.group_id = video_jobs.group_id
        AND newer.status IN ('waiting', 'queued', 'running')
        AND newer.id > video_jobs.id
   );

-- 每个镜头组最多一个进行中的任务；提交时的检查与插入再并发也不会产生第二个。
CREATE UNIQUE INDEX video_jobs_active_group_unique_idx ON video_jobs (group_id) WHERE status IN ('waiting', 'queued', 'running');
`
};
