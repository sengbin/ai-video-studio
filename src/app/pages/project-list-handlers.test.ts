// ------------------------------------------------------------------------
// 名称：project-list-handlers.test.ts
// 说明：项目列表页请求处理的自动化测试。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库与假的界面动作，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Project } from '../../domain/models/project';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { MessageRouter } from '../messaging/message-router';
import { ProjectService } from '../services/project-service';
import { PROJECT_LIST_REQUESTS, ProjectListActions, registerProjectListHandlers } from './project-list-handlers';

/** 创建路由器、服务和记录动作调用的夹具。 */
function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const service = new ProjectService(new SqliteProjectRepository(database));
  const calls = { createForm: 0, editForms: [] as Project[] };
  const actions: ProjectListActions = {
    openCreateForm: () => {
      calls.createForm += 1;
    },
    openEditForm: (project) => {
      calls.editForms.push(project);
    }
  };
  const router = new MessageRouter();
  registerProjectListHandlers(router, service, actions);
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { database, service, calls, send };
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

test('创建请求打开新建表单', async () => {
  const { database, calls, send } = createFixture();
  try {
    assert.ok((await send(PROJECT_LIST_REQUESTS.create))?.ok);
    assert.equal(calls.createForm, 1);
  } finally {
    database.close();
  }
});

test('编辑请求以项目内容打开编辑表单，项目不存在时返回错误', async () => {
  const { database, service, calls, send } = createFixture();
  try {
    const project = service.createProject({ name: '甲' });
    assert.ok((await send(PROJECT_LIST_REQUESTS.edit, { id: project.id }))?.ok);
    assert.equal(calls.editForms[0].name, '甲');

    const missing = await send(PROJECT_LIST_REQUESTS.edit, { id: 99 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
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
      const response = await send(PROJECT_LIST_REQUESTS.edit, payload);
      assert.ok(response && !response.ok && response.error.kind === 'validation', `载荷 ${JSON.stringify(payload)} 应被拒绝`);
    }
  } finally {
    database.close();
  }
});
