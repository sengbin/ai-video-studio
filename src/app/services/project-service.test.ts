// ------------------------------------------------------------------------
// 名称：project-service.test.ts
// 说明：项目服务与 SQLite 仓库的自动化测试：校验、重名、变化通知、删除影响统计。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { ProjectService } from './project-service';

/** 创建带可推进时钟的服务，每次读取时间前进一分钟。 */
function createService(): { service: ProjectService; database: DatabaseSync } {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  let minute = 0;
  const service = new ProjectService(new SqliteProjectRepository(database), () => new Date(Date.UTC(2026, 0, 1, 0, minute++)));
  return { service, database };
}

/** 捕获校验错误的字段错误记录。 */
function captureFieldErrors(action: () => unknown): Readonly<Record<string, string>> {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ValidationError, '应抛出 ValidationError');
    return error.fieldErrors;
  }
  assert.fail('应抛出 ValidationError');
}

test('创建项目：文本去除首尾空白，空的可选项保存为 null', () => {
  const { service, database } = createService();
  try {
    const project = service.createProject({
      name: '  灯塔计划  ',
      description: ' 关于灯塔守夜人 ',
      visualStyle: '',
      defaultAspectRatio: '16:9',
      defaultResolution: ''
    });

    assert.equal(project.name, '灯塔计划');
    assert.equal(project.description, '关于灯塔守夜人');
    assert.equal(project.visualStyle, null);
    assert.equal(project.defaultAspectRatio, '16:9');
    assert.equal(project.defaultResolution, null);
    assert.equal(project.createdAt, project.updatedAt);
  } finally {
    database.close();
  }
});

test('创建项目：名称必填且不超过 50 字', () => {
  const { service, database } = createService();
  try {
    assert.deepEqual(Object.keys(captureFieldErrors(() => service.createProject({ name: '   ' }))), ['name']);

    const errors = captureFieldErrors(() => service.createProject({ name: '字'.repeat(51) }));
    assert.match(errors.name, /不能超过 50 字/);
  } finally {
    database.close();
  }
});

test('创建项目：非法画幅、非法分辨率和非文本字段被拒绝，错误按字段汇总', () => {
  const { service, database } = createService();
  try {
    const errors = captureFieldErrors(() =>
      service.createProject({ name: '甲', description: 5, defaultAspectRatio: '2.39:1', defaultResolution: '8k' })
    );
    assert.deepEqual(Object.keys(errors).sort(), ['defaultAspectRatio', 'defaultResolution', 'description']);
  } finally {
    database.close();
  }
});

test('创建项目：提交内容不是对象时抛出表单级错误', () => {
  const { service, database } = createService();
  try {
    assert.deepEqual(Object.keys(captureFieldErrors(() => service.createProject('bad'))), ['']);
    assert.deepEqual(Object.keys(captureFieldErrors(() => service.createProject(null))), ['']);
  } finally {
    database.close();
  }
});

test('项目名称重复时抛出冲突错误，修改时可保留自己的名称', () => {
  const { service, database } = createService();
  try {
    const first = service.createProject({ name: '甲' });
    service.createProject({ name: '乙' });

    assert.throws(() => service.createProject({ name: ' 甲 ' }), ConflictError);
    assert.throws(() => service.updateProject(first.id, { name: '乙' }), ConflictError);
    assert.equal(service.updateProject(first.id, { name: '甲', description: '改了描述' }).description, '改了描述');
    assert.equal(service.isProjectNameAvailable('甲', first.id), true);
    assert.equal(service.isProjectNameAvailable('甲'), false);
    assert.equal(service.isProjectNameAvailable('丙'), true);
  } finally {
    database.close();
  }
});

test('修改和删除不存在的项目抛出 NotFoundError', () => {
  const { service, database } = createService();
  try {
    assert.throws(() => service.updateProject(99, { name: '甲' }), NotFoundError);
    assert.throws(() => service.deleteProject(99), NotFoundError);
    assert.throws(() => service.getProject(99), NotFoundError);
    assert.throws(() => service.getDeletionImpact(99), NotFoundError);
  } finally {
    database.close();
  }
});

test('项目列表按更新时间倒序，并带作品数和资产数', () => {
  const { service, database } = createService();
  try {
    const first = service.createProject({ name: '甲' });
    service.createProject({ name: '乙' });
    service.updateProject(first.id, { name: '甲' });
    database
      .prepare("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品', 'single', 't', 't')")
      .run(first.id);
    database
      .prepare("INSERT INTO assets (project_id, kind, name, created_at, updated_at) VALUES (?, 'scene', '灯塔', 't', 't')")
      .run(first.id);

    const summaries = service.listProjects();

    assert.deepEqual(summaries.map((item) => item.name), ['甲', '乙']);
    assert.equal(summaries[0].workCount, 1);
    assert.equal(summaries[0].assetCount, 1);
    assert.equal(summaries[1].workCount, 0);
  } finally {
    database.close();
  }
});

test('数据变化通知：成功的写操作通知，失败的不通知，取消订阅后不再通知', () => {
  const { service, database } = createService();
  try {
    let notifyCount = 0;
    const unsubscribe = service.onDidChangeProjects(() => {
      notifyCount += 1;
    });

    const project = service.createProject({ name: '甲' });
    service.updateProject(project.id, { name: '甲', description: '改' });
    assert.throws(() => service.createProject({ name: '甲' }));
    assert.throws(() => service.createProject({ name: '' }));
    service.deleteProject(project.id);
    assert.equal(notifyCount, 3);

    unsubscribe();
    service.createProject({ name: '乙' });
    assert.equal(notifyCount, 3);
  } finally {
    database.close();
  }
});

test('删除影响统计包含作品、资产和视频结果，删除后级联清除', () => {
  const { service, database } = createService();
  try {
    const project = service.createProject({ name: '甲' });
    const timestamp = 't';
    database
      .prepare("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品', 'series', ?, ?)")
      .run(project.id, timestamp, timestamp);
    database
      .prepare("INSERT INTO episodes (work_id, seq, title, created_at, updated_at) VALUES (1, 1, '第一集', ?, ?)")
      .run(timestamp, timestamp);
    database
      .prepare("INSERT INTO stage_runs (work_id, episode_id, stage, version, input_json, created_at) VALUES (1, 1, 'storyboard_script', 1, '{}', ?)")
      .run(timestamp);
    database.prepare('INSERT INTO storyboard_scripts (episode_id, run_id, created_at) VALUES (1, 1, ?)').run(timestamp);
    database
      .prepare("INSERT INTO shots (storyboard_script_id, seq, action, duration_seconds, created_at, updated_at) VALUES (1, 1, '远景', 5, ?, ?)")
      .run(timestamp, timestamp);
    database.prepare('INSERT INTO shot_groups (storyboard_script_id, seq, created_at) VALUES (1, 1, ?)').run(timestamp);
    database
      .prepare("INSERT INTO providers (code, display_name, created_at, updated_at) VALUES ('p', 'P', ?, ?)")
      .run(timestamp, timestamp);
    database.prepare("INSERT INTO models (provider_id, code, display_name, created_at) VALUES (1, 'm', 'M', ?)").run(timestamp);
    database
      .prepare("INSERT INTO video_jobs (group_id, model_id, status, request_snapshot_json, created_at) VALUES (1, 1, 'succeeded', '{}', ?)")
      .run(timestamp);
    const insertResult = database.prepare(
      "INSERT INTO video_results (job_id, group_id, file_path, duration_seconds, width, height, size_bytes, created_at) VALUES (1, 1, 'a.mp4', 5, 1280, 720, 10, ?)"
    );
    insertResult.run(timestamp);
    insertResult.run(timestamp);
    database
      .prepare("INSERT INTO assets (project_id, kind, name, created_at, updated_at) VALUES (?, 'prop', '钥匙', ?, ?)")
      .run(project.id, timestamp, timestamp);

    assert.deepEqual(service.getDeletionImpact(project.id), { workCount: 1, assetCount: 1, videoResultCount: 2 });

    service.deleteProject(project.id);

    const remaining = database.prepare('SELECT COUNT(*) AS total FROM video_results').get() as { total: number };
    assert.equal(remaining.total, 0);
    assert.equal(service.listProjects().length, 0);
  } finally {
    database.close();
  }
});
