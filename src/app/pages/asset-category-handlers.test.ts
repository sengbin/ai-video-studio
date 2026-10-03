// ------------------------------------------------------------------------
// 名称：asset-category-handlers.test.ts
// 说明：资产分类请求处理的自动化测试：删除前读取受影响的资产数量，删除后资产变为未分类，不存在或标识无效时返回错误。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用内存数据库与真实的服务，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetCategoryRepository } from '../../infra/database/sqlite-asset-category-repository';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { MessageRouter } from '../messaging/message-router';
import { AssetCategoryService } from '../services/asset-category-service';
import { AssetService } from '../services/asset-service';
import { ASSET_CATEGORY_REQUESTS, registerAssetCategoryHandlers } from './asset-category-handlers';
import { MemoryAssetFileStore } from '../../domain/ports/testing/memory-asset-file-store';

function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const categories = new AssetCategoryService(new SqliteAssetCategoryRepository(database));
  const assets = new AssetService(new SqliteAssetRepository(database, new MemoryAssetFileStore()));
  const router = new MessageRouter();
  registerAssetCategoryHandlers(router, categories);
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { database, categories, assets, send };
}

test('删除：先取名称与受影响的资产数量，再删除，资产保留并变为未分类', async () => {
  const { database, categories, assets, send } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '主角' });
    const asset = assets.createAsset('character', { name: '林夏' }, { categoryId: hero.id });

    const impact = await send(ASSET_CATEGORY_REQUESTS.prepareDelete, { id: hero.id });
    assert.deepEqual(impact?.ok && impact.data, { name: '主角', assetCount: 1 });

    const deleted = await send(ASSET_CATEGORY_REQUESTS.delete, { id: hero.id });
    assert.deepEqual(deleted?.ok && deleted.data, { deleted: true, name: '主角' });
    assert.deepEqual(categories.listCategories('character'), []);
    assert.equal(assets.getAsset(asset.id).categoryId, null);
  } finally {
    database.close();
  }
});

test('删除：分类不存在返回未找到，标识无效返回校验错误', async () => {
  const { database, send } = createFixture();
  try {
    const missing = await send(ASSET_CATEGORY_REQUESTS.delete, { id: 9999 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    const missingImpact = await send(ASSET_CATEGORY_REQUESTS.prepareDelete, { id: 9999 });
    assert.ok(missingImpact && !missingImpact.ok && missingImpact.error.kind === 'not-found');
    const invalid = await send(ASSET_CATEGORY_REQUESTS.prepareDelete, { id: 'x' });
    assert.ok(invalid && !invalid.ok && invalid.error.kind === 'validation');
  } finally {
    database.close();
  }
});
