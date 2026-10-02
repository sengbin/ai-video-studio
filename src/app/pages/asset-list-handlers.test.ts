// ------------------------------------------------------------------------
// 名称：asset-list-handlers.test.ts
// 说明：资产列表页请求处理的自动化测试：读取某类型的资产、取待处理请求、删除前的使用情况与删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库与真实的服务，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteProjectRepository } from '../../infra/database/sqlite-project-repository';
import { MessageRouter } from '../messaging/message-router';
import { AssetService } from '../services/asset-service';
import { ProjectService } from '../services/project-service';
import { ASSET_LIST_REQUESTS, AssetListRequest, AssetListRow, registerAssetListHandlers } from './asset-list-handlers';

function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const projects = new ProjectService(new SqliteProjectRepository(database));
  const assets = new AssetService(new SqliteAssetRepository(database), projects);
  projects.createProject({ name: '项目甲' });
  const state: { pending: AssetListRequest | undefined } = { pending: undefined };
  const router = new MessageRouter();
  registerAssetListHandlers(router, 'scene', { projects, assets }, {
    takePending: () => {
      const taken = state.pending;
      state.pending = undefined;
      return taken;
    }
  });
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { database, assets, state, send };
}

test('读取列表只返回页面绑定类型的资产，并带所属项目名称与项目清单', async () => {
  const { database, assets, send } = createFixture();
  try {
    assets.createAsset('scene', { projectName: '项目甲', name: '灯塔' });
    assets.createAsset('prop', { projectName: '项目甲', name: '钥匙' });
    const response = await send(ASSET_LIST_REQUESTS.load);
    assert.ok(response?.ok);
    const data = response.data as { kind: string; projects: Array<{ name: string }>; assets: AssetListRow[] };
    assert.equal(data.kind, 'scene');
    assert.deepEqual(data.projects.map((project) => project.name), ['项目甲']);
    assert.deepEqual(data.assets.map((asset) => [asset.name, asset.projectName]), [['灯塔', '项目甲']]);
  } finally {
    database.close();
  }
});

test('取待处理请求：有则返回并只返回一次', async () => {
  const { database, state, send } = createFixture();
  try {
    const none = await send(ASSET_LIST_REQUESTS.takePending);
    assert.deepEqual(none?.ok && none.data, { request: undefined });
    state.pending = { action: 'create' };
    const first = await send(ASSET_LIST_REQUESTS.takePending);
    assert.deepEqual(first?.ok && first.data, { request: { action: 'create' } });
    const second = await send(ASSET_LIST_REQUESTS.takePending);
    assert.deepEqual(second?.ok && second.data, { request: undefined });
  } finally {
    database.close();
  }
});

test('删除：先取名称与使用情况，再删除；不存在或标识无效时返回错误', async () => {
  const { database, assets, send } = createFixture();
  try {
    const asset = assets.createAsset('scene', { projectName: '项目甲', name: '灯塔' });
    const impact = await send(ASSET_LIST_REQUESTS.prepareDelete, { id: asset.id });
    assert.deepEqual(impact?.ok && impact.data, { name: '灯塔', usage: { bindings: [], soundReferences: 0 } });

    const deleted = await send(ASSET_LIST_REQUESTS.delete, { id: asset.id });
    assert.deepEqual(deleted?.ok && deleted.data, { deleted: true, name: '灯塔' });
    assert.equal(assets.listAssets('scene').length, 0);

    const missing = await send(ASSET_LIST_REQUESTS.delete, { id: asset.id });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    const invalid = await send(ASSET_LIST_REQUESTS.prepareDelete, { id: 'x' });
    assert.ok(invalid && !invalid.ok && invalid.error.kind === 'validation');
  } finally {
    database.close();
  }
});
