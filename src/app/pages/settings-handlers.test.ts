// ------------------------------------------------------------------------
// 名称：settings-handlers.test.ts
// 说明：模型设置页请求处理的自动化测试：加载文本生成设置与服务商视图、各修改请求的响应与错误。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：通过真实的消息路由器调用，使用内存数据库、假适配器和内存设置存储。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../domain/ports/testing/memory-secret-store';
import { TextGenerationSettingsStore } from '../../domain/ports/text-generation-settings-store';
import { TextGenerationSettings } from '../../domain/rules/text-generation-settings';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteProviderRepository } from '../../infra/database/sqlite-provider-repository';
import { MessageRouter } from '../messaging/message-router';
import { ProviderService } from '../services/provider-service';
import { TextSettingsService } from '../services/text-settings-service';
import { SETTINGS_REQUESTS, registerSettingsHandlers } from './settings-handlers';

/** 不保存任何内容的设置存储，本测试只关心路由。 */
const STORE: TextGenerationSettingsStore = {
  read: (): TextGenerationSettings => ({ modelFamily: '', novelSplit: { mode: 'chapter', maxSegmentChars: 20000 } }),
  write: async () => undefined
};

function createRouter() {
  const providers = new ProviderService({
    repository: new SqliteProviderRepository(openDatabase(IN_MEMORY_DATABASE_PATH)),
    registry: new ProviderRegistry().register(new FakeVideoProvider()),
    secrets: new MemorySecretStore()
  });
  providers.syncCatalog();
  const router = new MessageRouter();
  registerSettingsHandlers(router, { text: new TextSettingsService(STORE, { listFamilies: async () => ({ families: ['gpt-4o'] }) }), providers });
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
  readonly text: { readonly families: string[] };
  readonly providers: ProviderData[];
}

test('加载：同时返回文本生成设置与服务商视图', async () => {
  const { callOk } = createRouter();
  const data = await callOk<LoadedData>(SETTINGS_REQUESTS.load);
  assert.deepEqual(data.text.families, ['gpt-4o']);
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

test('服务商修改请求：校验失败返回字段错误，服务商不存在返回未找到', async () => {
  const { callOk, callError } = createRouter();
  const loaded = (await callOk<LoadedData>(SETTINGS_REQUESTS.load)).providers[0];

  const invalidKey = await callError(SETTINGS_REQUESTS.providerSetKey, { providerId: loaded.id, apiKey: '' });
  assert.equal(invalidKey.kind, 'validation');
  assert.ok(invalidKey.fieldErrors?.apiKey);

  const missing = await callError(SETTINGS_REQUESTS.providerUpdate, { providerId: 999, isEnabled: true });
  assert.equal(missing.kind, 'not-found');
});
