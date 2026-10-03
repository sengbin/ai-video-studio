// ------------------------------------------------------------------------
// 名称：settings-handlers.test.ts
// 说明：模型设置页请求处理的自动化测试：加载文本生成设置与服务商视图、各修改请求的响应与错误、测试连接。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：通过真实的消息路由器调用，使用内存数据库、假适配器和内存设置存储。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { FakeTextProvider, FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../domain/ports/testing/memory-secret-store';
import { TextGenerationSettingsStore } from '../../domain/ports/text-generation-settings-store';
import { WorkTextModelRepository } from '../../domain/ports/work-text-model-repository';
import { TextGenerationSettings, TextGenerationSettingsPatch } from '../../domain/rules/text-generation-settings';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteProviderRepository } from '../../infra/database/sqlite-provider-repository';
import { MessageRouter } from '../messaging/message-router';
import { ProviderService } from '../services/provider-service';
import { TextSettingsService } from '../services/text-settings-service';
import { SETTINGS_REQUESTS, registerSettingsHandlers } from './settings-handlers';

/** 不保存任何内容的设置存储，本测试只关心路由。 */
const STORE: TextGenerationSettingsStore = {
  read: (): TextGenerationSettings => ({ copilotEnabled: true, defaultModel: 'copilot:', novelSplit: { mode: 'chapter', maxSegmentChars: 20000 } }),
  write: async () => undefined
};

/** 不保存任何内容的作品文本模型选择。 */
const NO_WORK_MODELS: WorkTextModelRepository = { find: () => null, save: () => undefined };

function createRouter() {
  const providers = new ProviderService({
    repository: new SqliteProviderRepository(openDatabase(IN_MEMORY_DATABASE_PATH)),
    registry: new ProviderRegistry().register(new FakeVideoProvider()),
    secrets: new MemorySecretStore()
  });
  providers.syncCatalog();
  const router = new MessageRouter();
  registerSettingsHandlers(router, { text: new TextSettingsService(STORE, { listFamilies: async () => ({ families: ['gpt-4o'] }) }, providers, NO_WORK_MODELS), providers });
  const send = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  /** 发送请求并断言成功，返回响应数据。 */
  const callOk = async <T>(name: string, payload?: unknown): Promise<T> => {
    const response = await send(name, payload);
    assert.ok(response?.ok, '请求应成功');
    return response.data as T;
  };
  /** 发送请求并断言失败，返回错误载荷。 */
  const callError = async (name: string, payload?: unknown) => {
    const response = await send(name, payload);
    assert.ok(response !== undefined && !response.ok, '请求应失败');
    return response.error;
  };
  return { callOk, callError };
}

interface ProviderData {
  readonly id: number;
  readonly isEnabled: boolean;
  readonly apiKeyConfigured: boolean;
  readonly models: Array<{ id: number; isEnabled: boolean }>;
}

interface LoadedData {
  readonly text: { readonly choices: Array<{ key: string }> };
  readonly providers: ProviderData[];
}

test('加载：同时返回文本生成设置与服务商视图', async () => {
  const { callOk } = createRouter();
  const data = await callOk<LoadedData>(SETTINGS_REQUESTS.load);
  assert.deepEqual(data.text.choices.map((choice) => choice.key), ['copilot:', 'copilot:gpt-4o']);
  assert.equal(data.providers.length, 1);
  assert.equal(data.providers[0].models.length, 1);
});

test('服务商修改请求：返回修改后的服务商视图', async () => {
  const { callOk } = createRouter();
  const loaded = (await callOk<LoadedData>(SETTINGS_REQUESTS.load)).providers[0];

  const updated = await callOk<{ provider: ProviderData }>(SETTINGS_REQUESTS.providerUpdate, { providerId: loaded.id, isEnabled: false });
  assert.equal(updated.provider.isEnabled, false);

  const keyed = await callOk<{ provider: ProviderData }>(SETTINGS_REQUESTS.providerSetKey, { providerId: loaded.id, apiKey: 'sk-1' });
  assert.equal(keyed.provider.apiKeyConfigured, true);

  const cleared = await callOk<{ provider: ProviderData }>(SETTINGS_REQUESTS.providerClearKey, { providerId: loaded.id });
  assert.equal(cleared.provider.apiKeyConfigured, false);

  const toggled = await callOk<{ provider: ProviderData }>(SETTINGS_REQUESTS.modelSetEnabled, { modelId: loaded.models[0].id, isEnabled: false });
  assert.equal(toggled.provider.models[0].isEnabled, false);
});

test('测试连接请求：没有密钥时返回失败结果，配置密钥后返回成功；服务商不存在返回未找到', async () => {
  const { callOk, callError } = createRouter();
  const loaded = (await callOk<LoadedData>(SETTINGS_REQUESTS.load)).providers[0];
  assert.deepEqual(await callOk(SETTINGS_REQUESTS.providerTestConnection, { providerId: loaded.id }), { ok: false, message: '尚未配置访问密钥。' });
  await callOk(SETTINGS_REQUESTS.providerSetKey, { providerId: loaded.id, apiKey: 'sk-1' });
  assert.equal((await callOk<{ ok: boolean }>(SETTINGS_REQUESTS.providerTestConnection, { providerId: loaded.id })).ok, true);
  assert.equal((await callError(SETTINGS_REQUESTS.providerTestConnection, { providerId: 999 })).kind, 'not-found');
});

test('服务商修改请求：校验失败返回字段错误，服务商不存在返回未找到', async () => {
  const { callOk, callError } = createRouter();
  const loaded = (await callOk<LoadedData>(SETTINGS_REQUESTS.load)).providers[0];

  const invalidKey = await callError(SETTINGS_REQUESTS.providerSetKey, { providerId: loaded.id, apiKey: '' });
  assert.equal(invalidKey.kind, 'validation');
  assert.ok(invalidKey.fieldErrors?.apiKey);

  const missing = await callError(SETTINGS_REQUESTS.providerUpdate, { providerId: 999, isEnabled: true });
  assert.equal(missing.kind, 'not-found');
});

test('文本模型请求：默认模型与 Copilot 开关即时保存，选用未启用的模型返回字段错误，启用服务商文本模型后即可选用', async () => {
  let settings: TextGenerationSettings = { copilotEnabled: true, defaultModel: 'copilot:', novelSplit: { mode: 'chapter', maxSegmentChars: 20000 } };
  const store: TextGenerationSettingsStore = {
    read: () => settings,
    write: async (patch: TextGenerationSettingsPatch) => {
      settings = { ...settings, copilotEnabled: patch.copilotEnabled ?? settings.copilotEnabled, defaultModel: patch.defaultModel ?? settings.defaultModel };
    }
  };
  const providers = new ProviderService({
    repository: new SqliteProviderRepository(openDatabase(IN_MEMORY_DATABASE_PATH)),
    registry: new ProviderRegistry().register(new FakeVideoProvider()).register(new FakeTextProvider()),
    secrets: new MemorySecretStore()
  });
  providers.syncCatalog();
  const router = new MessageRouter();
  registerSettingsHandlers(router, { text: new TextSettingsService(store, { listFamilies: async () => ({ families: ['gpt-4o'] }) }, providers, NO_WORK_MODELS), providers });
  const send = async (name: string, payload?: unknown) => {
    const response = await router.handle({ type: 'request', requestId: 1, name, payload });
    assert.ok(response !== undefined);
    return response;
  };
  const loadChoices = async () => {
    const loaded = await send(SETTINGS_REQUESTS.load);
    assert.ok(loaded.ok);
    return (loaded.data as { text: { choices: Array<{ key: string }> } }).text.choices.map((choice) => choice.key);
  };

  assert.deepEqual(await loadChoices(), ['copilot:', 'copilot:gpt-4o']);
  const rejected = await send(SETTINGS_REQUESTS.update, { defaultModel: 'model:fake/fake-text' });
  assert.ok(!rejected.ok && rejected.error.kind === 'validation' && rejected.error.fieldErrors?.defaultModel);

  const text = providers.listSelectableTextModels();
  assert.equal(text.length, 0);
  const view = (await providers.listViews())[0];
  const model = view.models.find((item) => item.kind === 'text')!;
  assert.ok((await send(SETTINGS_REQUESTS.modelSetEnabled, { modelId: model.id, isEnabled: true })).ok);
  assert.deepEqual(await loadChoices(), ['copilot:', 'copilot:gpt-4o', 'model:fake/fake-text']);

  assert.ok((await send(SETTINGS_REQUESTS.update, { defaultModel: 'model:fake/fake-text' })).ok);
  assert.ok((await send(SETTINGS_REQUESTS.update, { copilotEnabled: false })).ok);
  assert.deepEqual(await loadChoices(), ['model:fake/fake-text']);
  assert.deepEqual([settings.defaultModel, settings.copilotEnabled], ['model:fake/fake-text', false]);

  // 停用模型后它不再出现在列表中。
  assert.ok((await send(SETTINGS_REQUESTS.modelSetEnabled, { modelId: model.id, isEnabled: false })).ok);
  assert.deepEqual(await loadChoices(), []);
});