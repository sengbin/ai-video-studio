// ------------------------------------------------------------------------
// 名称：asset-category-form.test.ts
// 说明：资产分类表单定义的自动化测试：创建、编辑的字段与标题、初始值、同类型内重名检查、提交，以及参数校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用内存数据库与真实的服务。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetCategoryRepository } from '../../infra/database/sqlite-asset-category-repository';
import { AssetCategoryService, DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE } from '../services/asset-category-service';
import { ASSET_CATEGORY_FORM_NAMES, createAssetCategoryFormCatalog } from './asset-category-form';
import { FormDefinition } from './form-definition';

function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const categories = new AssetCategoryService(new SqliteAssetCategoryRepository(database));
  const catalog = createAssetCategoryFormCatalog(categories);
  const open = (name: string, params: unknown): FormDefinition => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { database, categories, open };
}

test('创建分类表单：标题带类型名称，只有必填且唯一检查的名称字段，初始值为空', () => {
  const { database, open } = createFixture();
  try {
    const form = open(ASSET_CATEGORY_FORM_NAMES.create, { kind: 'character' });
    assert.equal(form.schema.title, '创建角色分类');
    assert.equal(open(ASSET_CATEGORY_FORM_NAMES.create, { kind: 'audio' }).schema.title, '创建音频分类');
    assert.deepEqual(form.schema.fields.map((field) => [field.key, field.control, field.required, field.checkUnique]), [['name', 'text', true, true]]);
    assert.deepEqual(form.initialValues, {});
  } finally {
    database.close();
  }
});

test('创建分类表单：类型无效时打不开；提交创建分类，重名冲突，名称为空校验失败', async () => {
  const { database, categories, open } = createFixture();
  try {
    assert.throws(() => open(ASSET_CATEGORY_FORM_NAMES.create, { kind: 'bogus' }), ValidationError);
    assert.throws(() => open(ASSET_CATEGORY_FORM_NAMES.create, undefined), ValidationError);

    const form = open(ASSET_CATEGORY_FORM_NAMES.create, { kind: 'character' });
    await form.submit({ name: '主角' });
    assert.deepEqual(categories.listCategories('character').map((item) => item.name), ['主角']);
    await assert.rejects(Promise.resolve().then(() => form.submit({ name: '主角' })), ConflictError);
    await assert.rejects(Promise.resolve().then(() => form.submit({ name: ' ' })), ValidationError);
  } finally {
    database.close();
  }
});

test('创建分类表单：名称检查只在同类型内判重，其他字段不检查', () => {
  const { database, categories, open } = createFixture();
  try {
    categories.createCategory('character', { name: '主角' });
    categories.createCategory('scene', { name: '室内' });
    const form = open(ASSET_CATEGORY_FORM_NAMES.create, { kind: 'character' });

    assert.equal(form.checkField?.('name', '主角'), DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE);
    assert.equal(form.checkField?.('name', '室内'), undefined);
    assert.equal(form.checkField?.('other', '主角'), undefined);
  } finally {
    database.close();
  }
});

test('编辑分类表单：带出名称，重名检查排除自身，提交后改名；分类不存在或标识无效时打不开', async () => {
  const { database, categories, open } = createFixture();
  try {
    const hero = categories.createCategory('character', { name: '主角' });
    categories.createCategory('character', { name: '配角' });

    const form = open(ASSET_CATEGORY_FORM_NAMES.edit, { categoryId: hero.id });
    assert.equal(form.schema.title, '编辑角色分类');
    assert.deepEqual(form.initialValues, { name: '主角' });
    assert.equal(form.checkField?.('name', '主角'), undefined);
    assert.equal(form.checkField?.('name', '配角'), DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE);

    await form.submit({ name: '男主角' });
    assert.equal(categories.getCategory(hero.id).name, '男主角');
    assert.throws(() => open(ASSET_CATEGORY_FORM_NAMES.edit, { categoryId: 9999 }), NotFoundError);
    assert.throws(() => open(ASSET_CATEGORY_FORM_NAMES.edit, {}), ValidationError);
  } finally {
    database.close();
  }
});
