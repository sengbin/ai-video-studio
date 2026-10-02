// ------------------------------------------------------------------------
// 名称：seed-generation.ts
// 说明：生成任务相关测试共用的种子数据：项目、作品、集、分镜脚本、若干镜头和一个视频模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除；直接用 SQL 写入，不经过服务层。
// ------------------------------------------------------------------------

import type { DatabaseSync } from 'node:sqlite';
import { FAKE_VIDEO_CAPABILITY } from '../../../domain/ports/testing/fake-model-providers';
import { SqliteProjectRepository } from '../sqlite-project-repository';
import { SqliteProviderRepository } from '../sqlite-provider-repository';

/** 种子数据的标识。 */
export interface GenerationSeed {
  readonly projectId: number;
  readonly workId: number;
  readonly episodeId: number;
  readonly runId: number;
  readonly shotIds: readonly number[];
  readonly modelId: number;
}

/**
 * 写入一个项目、一个作品、一集、一份分镜脚本、若干镜头和一个视频模型。
 * @param database 内存数据库。
 * @param shotCount 镜头数量。
 */
export function seedGeneration(database: DatabaseSync, shotCount = 2): GenerationSeed {
  const insert = (sql: string, ...params: Array<string | number>): number => Number(database.prepare(sql).run(...params).lastInsertRowid);
  const project = new SqliteProjectRepository(database).insert(
    { name: '项目甲', description: '', visualStyle: null, defaultAspectRatio: null, defaultResolution: null },
    't'
  );
  const workId = insert("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品甲', 'single', 't', 't')", project.id);
  const episodeId = insert("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (?, 1, '第一集', 't', 't')", workId);
  const runId = insert(
    "INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, status, review_status, is_current, created_at) VALUES (?, ?, 'storyboard_script', 1, '{}', 'succeeded', 'approved', 1, 't')",
    workId,
    episodeId
  );
  const scriptId = insert("INSERT INTO storyboard_scripts (episode_id, run_id, created_at) VALUES (?, ?, 't')", episodeId, runId);
  const shotIds = Array.from({ length: shotCount }, (_, index) =>
    insert(
      "INSERT INTO shots (storyboard_script_id, seq, action, duration_seconds, prompt_zh, created_at, updated_at) VALUES (?, ?, ?, 4, ?, 't', 't')",
      scriptId,
      index + 1,
      `镜头${index + 1}的画面`,
      `镜头${index + 1}的提示词`
    )
  );
  const providers = new SqliteProviderRepository(database);
  const provider = providers.insertProvider({ code: 'fake', displayName: '假服务商', settings: {} }, 't');
  const model = providers.upsertModel(provider.id, { code: 'fake-video', displayName: '假视频模型', kind: 'video', capability: FAKE_VIDEO_CAPABILITY }, 't');
  return { projectId: project.id, workId, episodeId, runId, shotIds, modelId: model.id };
}
