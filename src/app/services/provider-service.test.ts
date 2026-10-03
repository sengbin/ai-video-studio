// ------------------------------------------------------------------------
// 名称：provider-service.test.ts
// 说明：服务商应用服务的自动化测试：目录同步、设置页视图、启用与设置修改、访问密钥、测试连接、模型开关、可用模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、假适配器和内存密钥存储，不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, ProviderError, ValidationError } from '../../domain/errors';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { FAKE_PROVIDER_CODE, FAKE_VIDEO_CAPABILITY, FakeImageProvider, FakeTextProvider, FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../domain/ports/testing/memory-secret-store';
import { providerApiKeySecretKey } from '../../domain/rules/provider-rules';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteProviderRepository } from '../../infra/database/sqlite-provider-repository';
import { ProviderService } from './provider-service';

/** 创建带假适配器的服务；返回仓库、注册表与密钥存储以便检查。 */
function createService(registry = new ProviderRegistry().register(new FakeVideoProvider()).register(new FakeImageProvider())) {
  const repository = new SqliteProviderRepository(openDatabase(IN_MEMORY_DATABASE_PATH));
  const secrets = new MemorySecretStore();
  const service = new ProviderService({ repository, registry, secrets, now: () => new Date('2026-10-02T08:00:00.000Z') });
  service.syncCatalog();
  return { repository, secrets, service, registry };
}

/** 视图中的服务商。 */
async function onlyProvider(service: ProviderService) {
  const [provider] = await service.listViews();
  return provider;
}

test('同步目录：新服务商取默认设置，各类型适配器的模型都入库并默认启用', async () => {
  const { service } = createService();
  const provider = await onlyProvider(service);
  assert.deepEqual([provider.code, provider.displayName, provider.isEnabled, provider.apiKeyConfigured], [FAKE_PROVIDER_CODE, '假服务商', true, false]);
  assert.deepEqual(provider.settings.map((setting) => [setting.key, setting.value]), [['endpoint', 'https://fake.example.com/api'], ['region', 'cn']]);
  assert.deepEqual(provider.models.map((model) => [model.code, model.kindLabel, model.isEnabled]), [['fake-image', '图像', true], ['fake-video', '视频', true]]);
  assert.ok(provider.models.find((model) => model.code === 'fake-video')?.capabilitySummary.includes('画幅：16:9、9:16'));
});

test('再次同步：保留用户的启用状态与设置，更新能力，停用适配器不再提供的模型', async () => {
  const { repository, service } = createService();
  const provider = await onlyProvider(service);
  const video = provider.models.find((model) => model.code === 'fake-video')!;
  await service.setModelEnabled({ modelId: video.id, isEnabled: false });
  await service.updateProvider({ providerId: provider.id, settings: { region: 'intl' }, isEnabled: false });

  // 适配器改了视频模型的能力，并且不再提供图像模型。
  const changed = new ProviderRegistry().register(
    new FakeVideoProvider([{ code: 'fake-video', displayName: '假视频模型（新）', kind: 'video', capability: { ...FAKE_VIDEO_CAPABILITY, seed: false } }])
  );
  const second = new ProviderService({ repository, registry: changed, secrets: new MemorySecretStore() });
  second.syncCatalog();

  const after = await onlyProvider(second);
  assert.deepEqual([after.isEnabled, after.settings.find((setting) => setting.key === 'region')?.value], [false, 'intl']);
  const afterVideo = after.models.find((model) => model.code === 'fake-video')!;
  assert.deepEqual([afterVideo.displayName, afterVideo.isEnabled], ['假视频模型（新）', false]);
  assert.equal(after.models.find((model) => model.code === 'fake-image')?.isEnabled, false);
});

test('同步目录：同一服务商的模型代码重复时报错', () => {
  const duplicated = new ProviderRegistry().register(new FakeVideoProvider()).register(
    new FakeImageProvider([{ code: 'fake-video', displayName: '同名', kind: 'image', capability: { aspectRatios: [], resolutions: [], imagesPerRequestMax: 1, referenceImagesMax: 0, seed: false, promptLanguages: ['zh'], promptMaxLength: 1 } }])
  );
  assert.throws(() => createService(duplicated), /模型代码重复/);
});

test('视图只包含当前有适配器的服务商', async () => {
  const { repository } = createService();
  const service = new ProviderService({ repository, registry: new ProviderRegistry(), secrets: new MemorySecretStore() });
  assert.deepEqual(await service.listViews(), []);
  await assert.rejects(() => service.updateProvider({ providerId: 1, isEnabled: true }), NotFoundError);
});

test('修改服务商：启用状态与设置分别保存，设置按声明校验', async () => {
  const { service } = createService();
  const provider = await onlyProvider(service);

  const disabled = await service.updateProvider({ providerId: provider.id, isEnabled: false });
  assert.equal(disabled.isEnabled, false);

  const changed = await service.updateProvider({ providerId: provider.id, settings: { endpoint: ' https://example.org/v2/ ' } });
  assert.deepEqual(changed.settings.map((setting) => setting.value), ['https://example.org/v2', 'cn'], '只改出现的键，其余保持');
  assert.equal(changed.isEnabled, false, '只改设置时启用状态不变');

  await assert.rejects(() => service.updateProvider({ providerId: provider.id, settings: { endpoint: 'http://insecure.example.org' } }), (error) => error instanceof ValidationError && 'endpoint' in error.fieldErrors);
  await assert.rejects(() => service.updateProvider({ providerId: provider.id, settings: { region: 'mars' } }), ValidationError);
  await assert.rejects(() => service.updateProvider({ providerId: 999, isEnabled: true }), NotFoundError);
  assert.equal((await onlyProvider(service)).settings[0].value, 'https://example.org/v2', '校验失败不改变已保存的值');
});

test('访问密钥：保存后视图显示已配置，密钥只进密钥存储；清除后恢复未配置', async () => {
  const { secrets, service } = createService();
  const provider = await onlyProvider(service);

  const configured = await service.setApiKey({ providerId: provider.id, apiKey: ' sk-secret ' });
  assert.equal(configured.apiKeyConfigured, true);
  assert.equal(secrets.values.get(providerApiKeySecretKey(FAKE_PROVIDER_CODE)), 'sk-secret');
  assert.ok(!JSON.stringify(configured).includes('sk-secret'), '密钥不能出现在视图里');

  await assert.rejects(() => service.setApiKey({ providerId: provider.id, apiKey: 'has space' }), (error) => error instanceof ValidationError && 'apiKey' in error.fieldErrors);
  assert.equal(secrets.values.get(providerApiKeySecretKey(FAKE_PROVIDER_CODE)), 'sk-secret', '校验失败不覆盖旧密钥');

  const cleared = await service.clearApiKey({ providerId: provider.id });
  assert.equal(cleared.apiKeyConfigured, false);
  assert.equal(secrets.values.size, 0);
  await assert.rejects(() => service.clearApiKey({ providerId: 999 }), NotFoundError);
});

test('测试连接：用已保存的密钥和设置调用适配器，成功、分类失败、没有密钥、不支持都以结果返回', async () => {
  const video = new FakeVideoProvider();
  const { service } = createService(new ProviderRegistry().register(video));
  const provider = await onlyProvider(service);

  assert.deepEqual(await service.testConnection({ providerId: provider.id }), { ok: false, message: '尚未配置访问密钥。' });
  assert.equal(video.connectionChecks.length, 0, '没有密钥时不调用适配器');

  await service.setApiKey({ providerId: provider.id, apiKey: 'sk-test' });
  const ok = await service.testConnection({ providerId: provider.id });
  assert.equal(ok.ok, true);
  assert.match(ok.message, /连接成功/);
  assert.deepEqual([video.connectionChecks[0].apiKey, video.connectionChecks[0].settings.region, video.connectionChecks[0].signal !== undefined], ['sk-test', 'cn', true]);

  video.connectionError = new ProviderError('auth', 'Invalid API-key provided.', { code: 'InvalidApiKey' });
  const failed = await service.testConnection({ providerId: provider.id });
  assert.deepEqual(failed, { ok: false, message: '密钥或账号问题：Invalid API-key provided.' });
  assert.ok(!failed.message.includes('sk-test'));

  video.connectionError = new TypeError('非服务商错误');
  await assert.rejects(() => service.testConnection({ providerId: provider.id }), TypeError);
  await assert.rejects(() => service.testConnection({ providerId: 999 }), NotFoundError);
  await assert.rejects(() => service.testConnection({ providerId: 'x' }), ValidationError);
});

test('测试连接：没有适配器实现测试时说明暂不支持', async () => {
  const { service, secrets } = createService(new ProviderRegistry().register(new FakeImageProvider()));
  const provider = await onlyProvider(service);
  await secrets.set(providerApiKeySecretKey(FAKE_PROVIDER_CODE), 'sk-test');
  assert.deepEqual(await service.testConnection({ providerId: provider.id }), { ok: false, message: '“假服务商”暂不支持测试连接。' });
});

test('模型开关：返回所属服务商的视图；模型不存在时报错', async () => {
  const { service } = createService();
  const provider = await onlyProvider(service);
  const image = provider.models.find((model) => model.code === 'fake-image')!;

  const off = await service.setModelEnabled({ modelId: image.id, isEnabled: false });
  assert.equal(off.models.find((model) => model.id === image.id)?.isEnabled, false);
  const on = await service.setModelEnabled({ modelId: image.id, isEnabled: true });
  assert.equal(on.models.find((model) => model.id === image.id)?.isEnabled, true);
  await assert.rejects(() => service.setModelEnabled({ modelId: 999, isEnabled: true }), NotFoundError);
  await assert.rejects(() => service.setModelEnabled({ modelId: image.id, isEnabled: 'yes' }), ValidationError);
});

test('可用模型：服务商启用、已配置密钥、模型启用，三者都满足才可用', async () => {
  const { service } = createService();
  const provider = await onlyProvider(service);
  const usableVideos = async () => (await service.listUsableModels('video')).map((usable) => usable.model.code);

  assert.deepEqual(await usableVideos(), [], '没有密钥');
  await service.setApiKey({ providerId: provider.id, apiKey: 'sk-1' });
  assert.deepEqual(await usableVideos(), ['fake-video']);
  assert.deepEqual((await service.listUsableModels('video'))[0].providerName, '假服务商');
  assert.deepEqual((await service.listUsableModels('image')).map((usable) => usable.model.code), ['fake-image']);
  assert.deepEqual(await service.listUsableModels('audio'), [], '没有音频适配器');

  const video = provider.models.find((model) => model.code === 'fake-video')!;
  await service.setModelEnabled({ modelId: video.id, isEnabled: false });
  assert.deepEqual(await usableVideos(), [], '模型被停用');
  await service.setModelEnabled({ modelId: video.id, isEnabled: true });
  await service.updateProvider({ providerId: provider.id, isEnabled: false });
  assert.deepEqual(await usableVideos(), [], '服务商被停用');
});

test('文本模型：首次同步默认停用，启用后才可选；服务商停用时不可选；解析调用需要密钥', async () => {
  const registry = new ProviderRegistry().register(new FakeVideoProvider()).register(new FakeTextProvider());
  const { service, repository, secrets } = createService(registry);
  const text = repository.listModels({ kind: 'text' })[0];
  assert.deepEqual([text.code, text.kind, text.isEnabled], ['fake-text', 'text', false]);
  assert.equal((await onlyProvider(service)).models.find((model) => model.code === 'fake-text')?.kindLabel, '文本');
  assert.deepEqual(service.listSelectableTextModels(), []);

  await service.setModelEnabled({ modelId: text.id, isEnabled: true });
  const [selectable] = service.listSelectableTextModels();
  assert.deepEqual([selectable.providerCode, selectable.providerName, selectable.model.code], [FAKE_PROVIDER_CODE, '假服务商', 'fake-text']);
  assert.deepEqual(await service.listUsableModels('text'), [], '可选不要求密钥，可用要求');

  await assert.rejects(() => service.resolveTextCall(text.id), (error) => error instanceof ProviderError && error.category === 'auth');
  await secrets.set(providerApiKeySecretKey(FAKE_PROVIDER_CODE), 'sk-1');
  const call = await service.resolveTextCall(text.id);
  assert.deepEqual([call.modelCode, call.context.apiKey], ['fake-text', 'sk-1']);
  assert.equal((await service.listUsableModels('text')).length, 1);

  const provider = await onlyProvider(service);
  await service.updateProvider({ providerId: provider.id, isEnabled: false });
  assert.deepEqual(service.listSelectableTextModels(), []);
  await assert.rejects(() => service.resolveTextCall(text.id), ProviderError);
  await assert.rejects(() => service.resolveTextCall(text.id + 100), ProviderError);
});