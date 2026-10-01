// ------------------------------------------------------------------------
// 名称：project-list-handlers.test.ts
// 说明：项目列表页请求处理的自动化测试。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库与假的待执行动作，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Project } from '../../domain/models/project';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { MessageRouter } from '../messaging/message-router';
import { ProjectService } from '../services/project-service';
import { PROJECT_LIST_REQUESTS, ProjectListRequest, registerProjectListHandlers } from './project-list-handlers';

/** 创建路由器、服务和可设置待处理请求的夹具。 */
function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const service = new ProjectService(new SqliteProjectRepository(database));
  const state: { pendingAction: ProjectListRequest | undefined; openedProjectIds: number[] } = {
    pendingAction: undefined,
    openedProjectIds: []
  };
  const router = new MessageRouter();
  registerProjectListHandlers(router, service, {
    takePendingAction: () => {
      const taken = state.pendingAction;
      state.pendingAction = undefined;
      return taken;
    },
    markOpened: (projectId) => state.openedProjectIds.push(projectId)
  });
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { database, service, state, send };
}

test('读取列表返回项目摘要', async () => {
  const { database, service, send } = createFixture();
  try {
    service.createProject({ name: '甲' });
    const response = await send(PROJECT_LIST_REQUESTS.list);
    assert.ok(response?.ok);
    assert.deepEqual((response.data as Project[]).map((project) => project.name), ['甲']);
  } finally {
    database.close();
  }
});

test('取待处理请求：有则返回并只返回一次（动作、提示文字、详情层要求均可带），没有则为 undefined', async () => {
  const { database, state, send } = createFixture();
  try {
    const none = await send(PROJECT_LIST_REQUESTS.takePendingAction);
    assert.deepEqual(none?.ok && none.data, { action: undefined, notice: undefined, detail: undefined });

    state.pendingAction = { action: 'create' };
    const first = await send(PROJECT_LIST_REQUESTS.takePendingAction);
    assert.deepEqual(first?.ok && first.data, { action: 'create', notice: undefined, detail: undefined });
    const second = await send(PROJECT_LIST_REQUESTS.takePendingAction);
    assert.deepEqual(second?.ok && second.data, { action: undefined, notice: undefined, detail: undefined });

    state.pendingAction = { notice: '请先选择或创建项目' };
    const withNotice = await send(PROJECT_LIST_REQUESTS.takePendingAction);
    assert.deepEqual(withNotice?.ok && withNotice.data, { action: undefined, notice: '请先选择或创建项目', detail: undefined });

    state.pendingAction = { detail: { projectId: 3, createSource: 'novel' } };
    const withDetail = await send(PROJECT_LIST_REQUESTS.takePendingAction);
    assert.deepEqual(withDetail?.ok && withDetail.data, {
      action: undefined,
      notice: undefined,
      detail: { projectId: 3, createSource: 'novel' }
    });
  } finally {
    database.close();
  }
});

test('打开项目：登记为最近打开的项目，项目不存在时返回错误', async () => {
  const { database, service, state, send } = createFixture();
  try {
    const project = service.createProject({ name: '甲' });
    const opened = await send(PROJECT_LIST_REQUESTS.open, { id: project.id });
    assert.ok(opened?.ok);
    assert.deepEqual(state.openedProjectIds, [project.id]);

    const missing = await send(PROJECT_LIST_REQUESTS.open, { id: 999 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    assert.equal(state.openedProjectIds.length, 1);
  } finally {
    database.close();
  }
});

test('取删除影响范围返回项目名称和各类内容数量，项目不存在时返回错误', async () => {
  const { database, service, send } = createFixture();
  try {
    const project = service.createProject({ name: '甲' });
    database
      .prepare("INSERT INTO works (project_id, name, kind, created_at, updated_at) VALUES (?, '作品', 'single', 't', 't')")
      .run(project.id);

    const response = await send(PROJECT_LIST_REQUESTS.prepareDelete, { id: project.id });
    assert.deepEqual(response?.ok && response.data, { name: '甲', workCount: 1, assetCount: 0, videoResultCount: 0 });

    const missing = await send(PROJECT_LIST_REQUESTS.prepareDelete, { id: 99 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
  } finally {
    database.close();
  }
});

test('删除请求需要确认名称完全一致，不一致时保留项目并报字段错误', async () => {
  const { database, service, send } = createFixture();
  try {
    const project = service.createProject({ name: '甲' });
    for (const confirmName of ['', ' 甲', '乙', undefined]) {
      const response = await send(PROJECT_LIST_REQUESTS.delete, { id: project.id, confirmName });
      assert.ok(response && !response.ok && response.error.kind === 'validation', `确认名称 ${String(confirmName)} 应被拒绝`);
      assert.ok(response.error.fieldErrors && 'confirmName' in response.error.fieldErrors);
    }
    assert.equal(service.listProjects().length, 1);
  } finally {
    database.close();
  }
});

test('确认名称一致时删除项目并返回名称；重复删除返回错误', async () => {
  const { database, service, send } = createFixture();
  try {
    const project = service.createProject({ name: '甲' });
    const response = await send(PROJECT_LIST_REQUESTS.delete, { id: project.id, confirmName: '甲' });
    assert.deepEqual(response?.ok && response.data, { deleted: true, name: '甲' });
    assert.equal(service.listProjects().length, 0);

    const again = await send(PROJECT_LIST_REQUESTS.delete, { id: project.id, confirmName: '甲' });
    assert.ok(again && !again.ok && again.error.kind === 'not-found');
  } finally {
    database.close();
  }
});

test('项目标识必须是整数', async () => {
  const { database, send } = createFixture();
  try {
    for (const payload of [{ id: '1' }, { id: 1.5 }, {}, null]) {
      const response = await send(PROJECT_LIST_REQUESTS.prepareDelete, payload);
      assert.ok(response && !response.ok && response.error.kind === 'validation', `载荷 ${JSON.stringify(payload)} 应被拒绝`);
    }
  } finally {
    database.close();
  }
});
