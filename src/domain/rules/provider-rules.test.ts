// ------------------------------------------------------------------------
// 名称：provider-rules.test.ts
// 说明：服务商设置页提交规则的自动化测试：启用与设置项、访问密钥、模型启用、默认值合并与密钥名称。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用假服务商声明的设置项（https 地址、下拉），不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../errors';
import { FAKE_PROVIDER } from '../ports/testing/fake-model-providers';
import {
  API_KEY_MAX_LENGTH,
  normalizeProviderSettings,
  providerApiKeySecretKey,
  readApiKeyInput,
  readModelEnabledInput,
  readProviderId,
  readProviderUpdate,
  resolveProviderSettings
} from './provider-rules';

const FIELDS = FAKE_PROVIDER.settingFields;

/** 断言抛出校验错误，并返回字段错误。 */
function fieldErrorsOf(action: () => unknown): Record<string, string> {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof ValidationError, '应抛出校验错误');
    return { ...error.fieldErrors };
  }
  assert.fail('应抛出校验错误');
}

test('密钥名称包含服务商代码', () => {
  assert.equal(providerApiKeySecretKey('qianwen'), 'aiVideoStudio.provider.qianwen.apiKey');
});

test('设置默认值合并：缺失取默认值，不再声明的旧键丢弃', () => {
  assert.deepEqual(resolveProviderSettings(FIELDS, { region: 'intl', removed: 'x' }), { endpoint: 'https://fake.example.com/api', region: 'intl' });
});

test('读取服务商修改：标识必填，启用与设置至少一项', () => {
  assert.deepEqual(readProviderUpdate({ providerId: 3, isEnabled: false }), { providerId: 3, isEnabled: false, rawSettings: undefined });
  assert.deepEqual(readProviderUpdate({ providerId: 3, settings: { region: 'cn' } }).rawSettings, { region: 'cn' });
  assert.ok(fieldErrorsOf(() => readProviderUpdate({ isEnabled: true }))['']);
  assert.ok(fieldErrorsOf(() => readProviderUpdate({ providerId: 1.5, isEnabled: true }))['']);
  assert.ok(fieldErrorsOf(() => readProviderUpdate({ providerId: 1 }))['']);
  assert.ok(fieldErrorsOf(() => readProviderUpdate({ providerId: 1, isEnabled: 'yes' })).isEnabled);
  assert.ok(fieldErrorsOf(() => readProviderUpdate({ providerId: 1, settings: [] }))['']);
  assert.ok(fieldErrorsOf(() => readProviderUpdate(null))['']);
});

test('设置项校验：文本规范化、https 地址、下拉选项、未声明的键', () => {
  assert.deepEqual(normalizeProviderSettings({ endpoint: ' https://api.example.com/v1/ ', region: 'intl' }, FIELDS), {
    endpoint: 'https://api.example.com/v1',
    region: 'intl'
  });
  assert.deepEqual(normalizeProviderSettings({ region: 'cn' }, FIELDS), { region: 'cn' }, '只返回出现的键');

  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ endpoint: 'http://api.example.com' }, FIELDS)).endpoint);
  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ endpoint: 'https://user:pass@api.example.com' }, FIELDS)).endpoint);
  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ endpoint: 'not a url' }, FIELDS)).endpoint);
  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ endpoint: '   ' }, FIELDS)).endpoint);
  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ endpoint: 5 }, FIELDS)).endpoint);
  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ region: 'mars' }, FIELDS)).region);
  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ unknown: 'x' }, FIELDS)).unknown);
  assert.ok(fieldErrorsOf(() => normalizeProviderSettings({ endpoint: `https://a.com/${'x'.repeat(300)}` }, FIELDS)).endpoint);
});

test('访问密钥校验：去除首尾空白，拒绝空、含空白和过长', () => {
  assert.deepEqual(readApiKeyInput({ providerId: 2, apiKey: '  sk-abc  ' }), { providerId: 2, apiKey: 'sk-abc' });
  assert.ok(fieldErrorsOf(() => readApiKeyInput({ providerId: 2, apiKey: '' })).apiKey);
  assert.ok(fieldErrorsOf(() => readApiKeyInput({ providerId: 2 })).apiKey);
  assert.ok(fieldErrorsOf(() => readApiKeyInput({ providerId: 2, apiKey: 'sk a' })).apiKey);
  assert.ok(fieldErrorsOf(() => readApiKeyInput({ providerId: 2, apiKey: 'sk-\nabc' })).apiKey);
  assert.ok(fieldErrorsOf(() => readApiKeyInput({ providerId: 2, apiKey: 'k'.repeat(API_KEY_MAX_LENGTH + 1) })).apiKey);
  assert.ok(fieldErrorsOf(() => readApiKeyInput({ apiKey: 'sk-abc' }))['']);
});

test('读取服务商标识与模型启用请求', () => {
  assert.equal(readProviderId({ providerId: 4 }), 4);
  assert.ok(fieldErrorsOf(() => readProviderId({ providerId: '4' }))['']);
  assert.deepEqual(readModelEnabledInput({ modelId: 7, isEnabled: true }), { modelId: 7, isEnabled: true });
  assert.ok(fieldErrorsOf(() => readModelEnabledInput({ modelId: 7, isEnabled: 1 })).isEnabled);
  assert.ok(fieldErrorsOf(() => readModelEnabledInput({ isEnabled: true }))['']);
});
