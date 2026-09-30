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
function createFixture(deleteConfirmed = true) {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const service = new ProjectService(new SqliteProjectRepository(database));
  const calls = { createForm: 0, editForms: [] as Project[], deleteAsked: [] as Project[] };
  const actions: ProjectListActions = {
    openCreateForm: () => {
      calls.createForm += 1;
    },
    openEditForm: (project) => {
      calls.editForms.push(project);
    },
    confirmAndDelete: async (project) => {
      calls.deleteAsked.push(project);
      if (deleteConfirmed) service.deleteProject(project.id);
      return deleteConfirmed;
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

test('删除请求经确认后删除并返回结果；用户不确认则保留', async () => {
  const confirmed = createFixture(true);
  try {
    const project = confirmed.service.createProject({ name: '甲' });
    const response = await confirmed.send(PROJECT_LIST_REQUESTS.delete, { id: project.id });
    assert.deepEqual(response?.ok && response.data, { deleted: true });
    assert.equal(confirmed.service.listProjects().length, 0);
  } finally {
    confirmed.database.close();
  }

  const declined = createFixture(false);
  try {
    const project = declined.service.createProject({ name: '乙' });
    const response = await declined.send(PROJECT_LIST_REQUESTS.delete, { id: project.id });
    assert.deepEqual(response?.ok && response.data, { deleted: false });
    assert.equal(declined.service.listProjects().length, 1);
  } finally {
    declined.database.close();
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
