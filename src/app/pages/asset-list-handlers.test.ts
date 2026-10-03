// ------------------------------------------------------------------------
// 名称：asset-list-handlers.test.ts
// 说明：资产列表页请求处理的自动化测试：读取某类型的资产（含逐条的生成可用性）、取待处理请求、切换文件来源、删除前的使用情况与删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库与真实的服务，不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteAssetCategoryRepository } from '../../infra/database/sqlite-asset-category-repository';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteAssetVersionRepository } from '../../infra/database/sqlite-asset-version-repository';
import { MessageRouter } from '../messaging/message-router';
import { AssetCategoryService } from '../services/asset-category-service';
import { AssetGenerationService } from '../services/asset-generation-service';
import { AssetPromptService } from '../services/asset-prompt-service';
import { AssetService } from '../services/asset-service';
import { createAssetGenerationFixture, createAssetWithPrompts } from '../services/testing/asset-generation-fixture';
import { FILE_PROMPTS, ScriptedText } from '../stages/testing/scripted-text';
import { ASSET_LIST_REQUESTS, AssetListRequest, AssetListRow, registerAssetListHandlers } from './asset-list-handlers';
import { MemoryAssetFileStore } from '../../domain/ports/testing/memory-asset-file-store';

function createFixture() {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const files = new MemoryAssetFileStore();
  const assetRepository = new SqliteAssetRepository(database, files);
  const assets = new AssetService(assetRepository);
  const categories = new AssetCategoryService(new SqliteAssetCategoryRepository(database));
  const text = new ScriptedText(() => ({ promptZh: '中文', promptEn: 'english' }));
  const prompts = new AssetPromptService({ texts: text, prompts: FILE_PROMPTS, assets: assetRepository, notify: () => undefined });
  const generation = new AssetGenerationService({
    assets: assetRepository,
    versions: new SqliteAssetVersionRepository(database, files),
    providers: { listUsableModels: async () => [] },
    scheduler: { pump: async () => undefined, cancel: async () => ({ remoteCanceled: false }) },
    notify: () => undefined
  });
  const state: { pending: AssetListRequest | undefined } = { pending: undefined };
  const router = new MessageRouter();
  registerAssetListHandlers(router, 'scene', { assets, categories, prompts, generation }, {
    takePending: () => {
      const taken = state.pending;
      state.pending = undefined;
      return taken;
    }
  });
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { database, assets, categories, prompts, state, send };
}

test('读取列表只返回页面绑定类型的资产与分类，分类带资产数量', async () => {
  const { database, assets, categories, send } = createFixture();
  try {
    const lighthouse = categories.createCategory('scene', { name: '海边' });
    categories.createCategory('scene', { name: '室内' });
    categories.createCategory('prop', { name: '随身物品' });
    assets.createAsset('scene', { name: '灯塔' }, { categoryId: lighthouse.id });
    assets.createAsset('scene', { name: '客厅' });
    assets.createAsset('prop', { name: '钥匙' });
    const response = await send(ASSET_LIST_REQUESTS.load);
    assert.ok(response?.ok);
    const data = response.data as { kind: string; assets: AssetListRow[]; categories: Array<{ name: string; assetCount: number }> };
    assert.equal(data.kind, 'scene');
    assert.deepEqual(data.assets.map((asset) => [asset.name, asset.categoryId]), [['客厅', null], ['灯塔', lighthouse.id]]);
    assert.deepEqual(data.categories.map((category) => [category.name, category.assetCount]), [['海边', 1], ['室内', 0]]);
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

test('切换文件来源：没有上传的文件时拒绝，有上传的文件时可在上传与生成之间切换，来源参数无效时拒绝', async () => {
  const { database, assets, send } = createFixture();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const file = { name: 'a.png', mimeType: 'image/png', size: png.length, data: png.toString('base64'), width: 1, height: 1 };
    const asset = assets.createAsset('scene', { name: '灯塔' });
    const rejected = await send(ASSET_LIST_REQUESTS.switchSource, { id: asset.id, source: 'upload' });
    assert.equal(rejected?.ok, false);
    assert.equal((await send(ASSET_LIST_REQUESTS.switchSource, { id: asset.id, source: 'bogus' }))?.ok, false);

    assets.updateAsset(asset.id, { name: '灯塔', files: JSON.stringify([file]) }, { fileSource: 'upload' });
    assert.equal((await send(ASSET_LIST_REQUESTS.switchSource, { id: asset.id, source: 'generated' }))?.ok, true);
    assert.equal(assets.getAsset(asset.id).fileSource, 'generated');
    const listed = (await send(ASSET_LIST_REQUESTS.load)) as { ok: true; data: { assets: AssetListRow[] } };
    assert.deepEqual([listed.data.assets[0].fileSource, listed.data.assets[0].fileCount, listed.data.assets[0].uploadFileCount], ['generated', 0, 1]);
    assert.equal((await send(ASSET_LIST_REQUESTS.switchSource, { id: asset.id, source: 'upload' }))?.ok, true);
    assert.equal(assets.getAsset(asset.id).fileSource, 'upload');
  } finally {
    database.close();
  }
});

test('参考原图：返回第一张参考图的类型与内容，没有参考图时返回错误', async () => {
  const { database, assets, send } = createFixture();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const file = { name: 'a.png', mimeType: 'image/png', size: png.length, data: png.toString('base64'), width: 1, height: 1 };
    const withImage = assets.createAsset('scene', { name: '灯塔', files: JSON.stringify([file]) }, { fileSource: 'upload' });
    const image = await send(ASSET_LIST_REQUESTS.referenceImage, { id: withImage.id });
    assert.deepEqual(image?.ok && image.data, { mime: 'image/png', data: png.toString('base64') });

    const without = assets.createAsset('scene', { name: '空场景' });
    const missing = await send(ASSET_LIST_REQUESTS.referenceImage, { id: without.id });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
  } finally {
    database.close();
  }
});

test('参考音频：返回音频资产的参考音频类型与内容，没有参考音频时返回错误', async () => {
  const { database, assets, send } = createFixture();
  try {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVEfmt ')]);
    const file = { name: 'v.wav', mimeType: 'audio/wav', size: wav.length, data: wav.toString('base64'), durationSeconds: 5 };
    const voice = assets.createAsset('audio', { name: '林夕的声音', audioKind: 'voice', files: JSON.stringify([file]) }, { fileSource: 'upload' });
    const audio = await send(ASSET_LIST_REQUESTS.referenceAudio, { id: voice.id });
    assert.deepEqual(audio?.ok && audio.data, { mime: 'audio/wav', data: wav.toString('base64') });

    const without = assets.createAsset('audio', { name: '空音频', audioKind: 'sfx' });
    const missing = await send(ASSET_LIST_REQUESTS.referenceAudio, { id: without.id });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
  } finally {
    database.close();
  }
});

test('删除：先取名称与使用情况，再删除；不存在或标识无效时返回错误', async () => {
  const { database, assets, send } = createFixture();
  try {
    const asset = assets.createAsset('scene', { name: '灯塔' });
    const impact = await send(ASSET_LIST_REQUESTS.prepareDelete, { id: asset.id });
    assert.deepEqual(impact?.ok && impact.data, { name: '灯塔', usage: { bindings: [], soundReferences: 0, soundEpisodes: [], voiceBindingCount: 0 } });

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

test('读取列表：音频资产按各自的音频类型逐条判断有无可用模型，不能按“有音频模型”一刀切', async () => {
  const fixture = await createAssetGenerationFixture();
  try {
    // 假音频模型只支持音色参考和音效，不支持背景音乐。
    createAssetWithPrompts(fixture.assets, 'audio', { name: '声音', audioKind: '音色参考', promptZh: '清亮的女声' });
    createAssetWithPrompts(fixture.assets, 'audio', { name: '配乐', audioKind: '背景音乐', promptZh: '紧张的弦乐' });
    createAssetWithPrompts(fixture.assets, 'audio', { name: '雨声', audioKind: '音效', promptZh: '雨打窗' });
    const text = new ScriptedText(() => ({ promptZh: '中文', promptEn: 'english' }));
    const router = new MessageRouter();
    registerAssetListHandlers(
      router,
      'audio',
      {
        assets: fixture.assets,
        categories: new AssetCategoryService(new SqliteAssetCategoryRepository(fixture.database)),
        prompts: new AssetPromptService({ texts: text, prompts: FILE_PROMPTS, assets: fixture.assetRepository, notify: () => undefined }),
        generation: fixture.generation
      },
      { takePending: () => undefined }
    );
    const response = await router.handle({ type: 'request', requestId: 1, name: ASSET_LIST_REQUESTS.load, payload: undefined });
    assert.ok(response?.ok);
    const rows = (response.data as { assets: AssetListRow[] }).assets;
    const availability = Object.fromEntries(rows.map((row) => [row.name, row.availability.available]));
    assert.deepEqual(availability, { 声音: true, 配乐: false, 雨声: true });
    assert.match(rows.find((row) => row.name === '配乐')?.availability.reason ?? '', /启用音频模型/);
  } finally {
    fixture.database.close();
  }
});