// ------------------------------------------------------------------------
// 名称：sqlite-provider-repository.test.ts
// 说明：服务商与模型仓库的自动化测试：新增、修改、能力 JSON 往返、同步时保留启用状态、停用不再提供的模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库和假适配器声明。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FAKE_IMAGE_CAPABILITY, FAKE_TEXT_CAPABILITY, FAKE_VIDEO_CAPABILITY } from '../../domain/ports/testing/fake-model-providers';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from './database-connection';
import { SqliteProviderRepository } from './sqlite-provider-repository';

const T1 = '2026-10-02T00:00:00.000Z';
const T2 = '2026-10-02T01:00:00.000Z';

function createRepository() {
  return new SqliteProviderRepository(openDatabase(IN_MEMORY_DATABASE_PATH));
}

const VIDEO_MODEL = { code: 'v1', displayName: '视频一', kind: 'video' as const, capability: FAKE_VIDEO_CAPABILITY };
const IMAGE_MODEL = { code: 'i1', displayName: '图像一', kind: 'image' as const, capability: FAKE_IMAGE_CAPABILITY };

test('新增服务商：默认启用，设置按 JSON 往返，可按标识和代码查找', () => {
  const repository = createRepository();
  const provider = repository.insertProvider({ code: 'p', displayName: '甲', settings: { endpoint: 'https://a.com' } }, T1);
  assert.deepEqual(provider, { id: provider.id, code: 'p', displayName: '甲', settings: { endpoint: 'https://a.com' }, isEnabled: true, createdAt: T1, updatedAt: T1 });
  assert.deepEqual(repository.findProviderById(provider.id), provider);
  assert.deepEqual(repository.findProviderByCode('p'), provider);
  assert.equal(repository.findProviderByCode('none'), undefined);
  assert.equal(repository.listProviders().length, 1);
  assert.throws(() => repository.insertProvider({ code: 'p', displayName: '乙', settings: {} }, T1), 'code 唯一');
});

test('修改服务商：启用状态与设置分别更新，未提供的项保持不变', () => {
  const repository = createRepository();
  const { id } = repository.insertProvider({ code: 'p', displayName: '甲', settings: { endpoint: 'https://a.com' } }, T1);

  const disabled = repository.updateProvider(id, { isEnabled: false }, T2);
  assert.deepEqual([disabled?.isEnabled, disabled?.settings, disabled?.updatedAt], [false, { endpoint: 'https://a.com' }, T2]);

  const changed = repository.updateProvider(id, { settings: { endpoint: 'https://b.com' } }, T2);
  assert.deepEqual([changed?.isEnabled, changed?.settings], [false, { endpoint: 'https://b.com' }]);

  assert.equal(repository.updateProvider(999, { isEnabled: true }, T2), undefined);

  repository.updateProviderName(id, '甲（新）', T2);
  assert.equal(repository.findProviderById(id)?.displayName, '甲（新）');
});

test('模型：新增时默认启用，能力往返；按服务商和类型筛选', () => {
  const repository = createRepository();
  const { id: providerId } = repository.insertProvider({ code: 'p', displayName: '甲', settings: {} }, T1);
  const other = repository.insertProvider({ code: 'q', displayName: '乙', settings: {} }, T1);

  const video = repository.upsertModel(providerId, VIDEO_MODEL, T1);
  repository.upsertModel(providerId, IMAGE_MODEL, T1);
  repository.upsertModel(other.id, { ...VIDEO_MODEL, code: 'v2' }, T1);

  assert.deepEqual([video.code, video.kind, video.isEnabled, video.capability], ['v1', 'video', true, FAKE_VIDEO_CAPABILITY]);
  assert.deepEqual(repository.listModels({ providerId }).map((model) => model.code), ['i1', 'v1'], '按类型排序：image 在 video 之前');
  assert.deepEqual(repository.listModels({ kind: 'video' }).map((model) => model.code), ['v1', 'v2']);
  assert.deepEqual(repository.listModels({ providerId, kind: 'image' }).map((model) => model.code), ['i1']);
  assert.deepEqual(repository.findModelById(video.id), video);
  assert.equal(repository.findModelById(999), undefined);
});

test('同步模型：更新名称与能力但保留启用状态；停用不再提供的模型', () => {
  const repository = createRepository();
  const { id: providerId } = repository.insertProvider({ code: 'p', displayName: '甲', settings: {} }, T1);
  const first = repository.upsertModel(providerId, VIDEO_MODEL, T1);
  repository.upsertModel(providerId, IMAGE_MODEL, T1);

  assert.equal(repository.setModelEnabled(first.id, false), true);
  assert.equal(repository.setModelEnabled(999, false), false);

  const updated = repository.upsertModel(providerId, { ...VIDEO_MODEL, displayName: '视频一（新）', capability: { ...FAKE_VIDEO_CAPABILITY, seed: false } }, T2);
  assert.equal(updated.id, first.id, '同一模型代码沿用原记录');
  assert.deepEqual([updated.displayName, updated.isEnabled, (updated.capability as { seed: boolean }).seed], ['视频一（新）', false, false]);

  repository.setModelEnabled(first.id, true);
  repository.disableModelsExcept(providerId, ['v1']);
  assert.deepEqual(
    repository.listModels({ providerId }).map((model) => [model.code, model.isEnabled]).sort(),
    [['i1', false], ['v1', true]]
  );
  repository.disableModelsExcept(providerId, []);
  assert.ok(repository.listModels({ providerId }).every((model) => !model.isEnabled));
});

test('新增文本模型：默认停用，其他类型默认启用；同步更新时保留用户的启用状态', () => {
  const repository = createRepository();
  const { id } = repository.insertProvider({ code: 'p', displayName: '甲', settings: {} }, T1);
  const text = { code: 't1', displayName: '文本一', kind: 'text' as const, capability: FAKE_TEXT_CAPABILITY };
  const created = repository.upsertModel(id, text, T1);
  assert.deepEqual([created.kind, created.isEnabled, created.capability], ['text', false, FAKE_TEXT_CAPABILITY]);
  assert.equal(repository.upsertModel(id, VIDEO_MODEL, T1).isEnabled, true);

  repository.setModelEnabled(created.id, true);
  assert.equal(repository.upsertModel(id, { ...text, displayName: '文本一（新）' }, T2).isEnabled, true);
  assert.deepEqual(repository.listModels({ kind: 'text' }).map((model) => model.displayName), ['文本一（新）']);
});