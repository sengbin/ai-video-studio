// ------------------------------------------------------------------------
// 名称：asset-category-service.test.ts
// 说明：资产分类应用服务（含分类规则与 SQLite 仓库）的自动化测试：创建、校验、同类型内重名、重命名、删除后资产变为未分类、分类名称解析，以及资产与分类的关联。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用内存数据库与真实的仓库；“不分类”一律用 null 表示。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { ASSET_CATEGORY_NAME_MAX_LENGTH } from '../../domain/rules/asset-category-rules';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetCategoryRepository } from '../../infra/database/sqlite-asset-category-repository';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { AssetCategoryService, DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE } from './asset-category-service';
import { AssetService } from './asset-service';
import { MemoryAssetFileStore } from '../../domain/ports/testing/memory-asset-file-store';

/** 创建分类服务、资产服务与内存数据库。 */
function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const categories = new AssetCategoryService(new SqliteAssetCategoryRepository(database));
  const assets = new AssetService(new SqliteAssetRepository(database, new MemoryAssetFileStore()));
  return { database, categories, assets };
}

test('创建分类：名称去除首尾空白，按类型列出并带资产数量，不同类型互不影响', () => {
  const { database, categories } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '  主角  ' });
    categories.createCategory('character', { name: '配角' });
    categories.createCategory('scene', { name: '室内' });

    assert.equal(hero.name, '主角');
    assert.equal(hero.kind, 'character');
    assert.deepEqual(categories.listCategories('character').map((item) => [item.name, item.assetCount]), [['主角', 0], ['配角', 0]]);
    assert.deepEqual(categories.listCategories('scene').map((item) => item.name), ['室内']);
    assert.deepEqual(categories.listCategories('audio'), []);
  } finally {
    database.close();
  }
});

test('创建分类：名称为空或过长时校验失败，同类型重名冲突，不同类型同名允许', () => {
  const { database, categories } = createFixture();
  try {
    assert.throws(() => categories.createCategory('character', { name: '   ' }), ValidationError);
    assert.throws(() => categories.createCategory('character', {}), ValidationError);
    assert.throws(() => categories.createCategory('character', { name: 'x'.repeat(ASSET_CATEGORY_NAME_MAX_LENGTH + 1) }), ValidationError);
    assert.throws(() => categories.createCategory('character', 'x'), ValidationError);

    categories.createCategory('character', { name: '主角' });
    assert.throws(() => categories.createCategory('character', { name: ' 主角 ' }), ConflictError);
    categories.createCategory('scene', { name: '主角' });
    assert.equal(categories.isNameAvailable('character', '主角'), false);
    assert.equal(categories.isNameAvailable('character', '配角'), true);
    assert.equal(DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE, '已有同名分类，请换一个名称。');
  } finally {
    database.close();
  }
});

test('重命名分类：排除自身的重名检查，与同类型其他分类重名时冲突，分类不存在时报错', () => {
  const { database, categories } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '主角' });
    categories.createCategory('character', { name: '配角' });

    assert.equal(categories.isNameAvailable('character', '主角', hero.id), true);
    assert.equal(categories.updateCategory(hero.id, { name: '主角' }).name, '主角');
    assert.equal(categories.updateCategory(hero.id, { name: '男主角' }).name, '男主角');
    assert.throws(() => categories.updateCategory(hero.id, { name: '配角' }), ConflictError);
    assert.throws(() => categories.updateCategory(hero.id, { name: '' }), ValidationError);
    assert.throws(() => categories.updateCategory(9999, { name: '甲' }), NotFoundError);
  } finally {
    database.close();
  }
});

test('分类变化后通知订阅者，取消订阅后不再通知', () => {
  const { database, categories } = createFixture();
  try {
    let count = 0;
    const unsubscribe = categories.onDidChangeCategories(() => (count += 1));
    const hero = categories.createCategory('character', { name: '主角' });
    categories.updateCategory(hero.id, { name: '男主角' });
    categories.deleteCategory(hero.id);
    assert.equal(count, 3);

    unsubscribe();
    categories.createCategory('character', { name: '配角' });
    assert.equal(count, 3);
  } finally {
    database.close();
  }
});

test('创建与修改资产时指定分类；不指定为 null，修改时不传保持原分类，传 null 改为不分类', () => {
  const { database, categories, assets } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '主角' });
    const support = categories.createCategory('character', { name: '配角' });

    const plain = assets.createAsset('character', { name: '路人' });
    assert.equal(plain.categoryId, null);
    const asset = assets.createAsset('character', { name: '林夏' }, { categoryId: hero.id });
    assert.equal(asset.categoryId, hero.id);

    assert.equal(assets.updateAsset(asset.id, { name: '林夏' }).categoryId, hero.id);
    assert.equal(assets.updateAsset(asset.id, { name: '林夏' }, { categoryId: support.id }).categoryId, support.id);
    assert.equal(assets.updateAsset(asset.id, { name: '林夏' }, { categoryId: null }).categoryId, null);

    assets.updateAsset(asset.id, { name: '林夏' }, { categoryId: hero.id });
    assert.deepEqual(categories.listCategories('character').map((item) => [item.name, item.assetCount]), [['主角', 1], ['配角', 0]]);
    assert.deepEqual(assets.listAssets('character').map((item) => [item.name, item.categoryId]), [['林夏', hero.id], ['路人', null]]);
  } finally {
    database.close();
  }
});

test('改分类不改变资产的内容修订号，提示词不会因此变成“需更新”', () => {
  const { database, categories, assets } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '主角' });
    const asset = assets.createAsset('character', { name: '林夏', appearance: '短发' });
    const updated = assets.updateAsset(asset.id, { name: '林夏', appearance: '短发' }, { categoryId: hero.id });

    assert.equal(updated.categoryId, hero.id);
    assert.equal(updated.contentRevision, asset.contentRevision);
    assert.equal(updated.promptContentRevision, asset.promptContentRevision);
  } finally {
    database.close();
  }
});

test('删除分类：先取受影响的资产数量；删除后资产保留并变为未分类，分类不存在时报错', () => {
  const { database, categories, assets } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '主角' });
    const first = assets.createAsset('character', { name: '林夏' }, { categoryId: hero.id });
    assets.createAsset('character', { name: '周远' }, { categoryId: hero.id });
    const other = assets.createAsset('character', { name: '路人' });

    assert.deepEqual(categories.getDeletionImpact(hero.id), { name: '主角', assetCount: 2 });
    categories.deleteCategory(hero.id);

    assert.equal(assets.getAsset(first.id).categoryId, null);
    assert.equal(assets.getAsset(other.id).categoryId, null);
    assert.equal(assets.listAssets('character').length, 3);
    assert.deepEqual(categories.listCategories('character'), []);
    assert.throws(() => categories.deleteCategory(hero.id), NotFoundError);
    assert.throws(() => categories.getDeletionImpact(hero.id), NotFoundError);
  } finally {
    database.close();
  }
});

test('解析分类名称：空串为不分类，已有分类返回标识，不存在或类型不符时报错', () => {
  const { database, categories } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '主角' });

    assert.equal(categories.resolveCategoryId('character', ''), null);
    assert.equal(categories.resolveCategoryId('character', '  '), null);
    assert.equal(categories.resolveCategoryId('character', '主角'), hero.id);
    assert.throws(() => categories.resolveCategoryId('character', '不存在'), ValidationError);
    assert.throws(() => categories.resolveCategoryId('scene', '主角'), ValidationError);
  } finally {
    database.close();
  }
});
