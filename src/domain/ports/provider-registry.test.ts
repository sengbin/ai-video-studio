// ------------------------------------------------------------------------
// 名称：provider-registry.test.ts
// 说明：适配器注册表的自动化测试：按（类型，服务商）取适配器、重复登记、同一服务商声明一致性。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用假适配器。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderDescriptor } from '../models/model-provider';
import { ProviderRegistry } from './provider-registry';
import { FAKE_PROVIDER, FAKE_PROVIDER_CODE, FakeImageProvider, FakeVideoProvider } from './testing/fake-model-providers';

test('按类型和服务商代码取得适配器', () => {
  const video = new FakeVideoProvider();
  const image = new FakeImageProvider();
  const registry = new ProviderRegistry().register(video).register(image);

  assert.equal(registry.find('video', FAKE_PROVIDER_CODE), video);
  assert.equal(registry.find('image', FAKE_PROVIDER_CODE), image);
  assert.equal(registry.find('audio', FAKE_PROVIDER_CODE), undefined);
  assert.equal(registry.find('video', 'other'), undefined);
  assert.deepEqual(registry.listProviders(), [FAKE_PROVIDER]);
  assert.deepEqual(registry.listAdapters(FAKE_PROVIDER_CODE), [video, image]);
  assert.equal(registry.findProvider(FAKE_PROVIDER_CODE), FAKE_PROVIDER);
  assert.equal(registry.findProvider('other'), undefined);
});

test('同一类型和服务商不能重复登记', () => {
  const registry = new ProviderRegistry().register(new FakeVideoProvider());
  assert.throws(() => registry.register(new FakeVideoProvider()), /已登记video模型适配器/);
});

test('同一服务商的各类型适配器必须声明相同的服务商信息', () => {
  class OtherNameImageProvider extends FakeImageProvider {
    override readonly provider: ProviderDescriptor = { ...FAKE_PROVIDER, displayName: '另一个名字' };
  }
  const registry = new ProviderRegistry().register(new FakeVideoProvider());
  assert.throws(() => registry.register(new OtherNameImageProvider()), /相同的服务商信息/);
  assert.equal(registry.find('image', FAKE_PROVIDER_CODE), undefined, '登记失败不应留下半个登记');
});
