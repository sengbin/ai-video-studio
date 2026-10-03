// ------------------------------------------------------------------------
// 名称：text-generation-router.test.ts
// 说明：文本生成路由的自动化测试：按设置选择 Copilot 或千问文本模型、没有可用引擎时的错误、服务商失败转换为文本生成错误、取消信号传递。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用假的 Copilot 端口与假的文本适配器，不依赖 VS Code 与网络。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError, TextGenerationError } from '../../domain/errors';
import { TextCapability } from '../../domain/models/model-capability';
import { ModelRecord } from '../../domain/models/model-provider';
import { ProviderCallContext, ResolvedTextCall, TextModelProvider } from '../../domain/ports/provider-adapters';
import { TextGenerationPort, TextGenerationRequest, TextModelInfo } from '../../domain/ports/text-generation-port';
import { estimateTokens } from '../../domain/rules/token-estimate';
import { NO_TEXT_ENGINE_MESSAGE, TextGenerationRouter } from './text-generation-router';

const CAPABILITY: TextCapability = { contextTokens: 1000, maxOutputTokens: 200, imageInput: true };
const REQUEST: TextGenerationRequest = { system: 's', user: 'u', tool: { name: 't', description: 'd', inputSchema: { type: 'object' } } };
const COPILOT_INFO: TextModelInfo = { id: 'copilot/gpt', maxInputTokens: 5000 };

/** 假 Copilot 端口：记录调用。 */
class FakeCopilot implements TextGenerationPort {
  readonly calls: string[] = [];

  async resolveModel(): Promise<TextModelInfo> {
    this.calls.push('resolve');
    return COPILOT_INFO;
  }

  async countTokens(): Promise<number> {
    this.calls.push('count');
    return 42;
  }

  async generate(): Promise<unknown> {
    this.calls.push('generate');
    return { from: 'copilot' };
  }
}

/** 假文本适配器：返回预设结果或抛出预设错误，记录收到的上下文。 */
class FakeTextAdapter implements TextModelProvider {
  readonly kind = 'text';
  readonly provider = { code: 'fake', displayName: '假服务商', settingFields: [] };
  readonly contexts: ProviderCallContext[] = [];
  failure: unknown = undefined;

  listModels() {
    return [];
  }

  getCapability(modelCode: string): TextCapability | undefined {
    return modelCode === 'gone' ? undefined : CAPABILITY;
  }

  async generate(_modelCode: string, _request: TextGenerationRequest, context: ProviderCallContext): Promise<unknown> {
    this.contexts.push(context);
    if (this.failure !== undefined) throw this.failure;
    return { from: 'provider' };
  }
}

function model(id: number, isEnabled: boolean, code = 'm'): ModelRecord {
  return { id, providerId: 1, code, displayName: code, kind: 'text', isEnabled, capability: CAPABILITY, createdAt: '' };
}

function createRouter(options: { copilotEnabled: boolean; models: ModelRecord[]; resolveFailure?: unknown }) {
  const copilot = new FakeCopilot();
  const adapter = new FakeTextAdapter();
  const settings = { copilotEnabled: options.copilotEnabled };
  const resolved: number[] = [];
  const router = new TextGenerationRouter({
    settings: { isCopilotEnabled: () => settings.copilotEnabled },
    copilot,
    providers: {
      listTextModels: () => options.models,
      resolveTextCall: async (modelId): Promise<ResolvedTextCall> => {
        resolved.push(modelId);
        if (options.resolveFailure !== undefined) throw options.resolveFailure;
        const code = options.models.find((item) => item.id === modelId)?.code ?? 'm';
        return { adapter, modelCode: code, context: { apiKey: 'sk', settings: {} } };
      }
    }
  });
  return { router, copilot, adapter, settings, resolved };
}

async function rejectedWith(action: Promise<unknown>): Promise<TextGenerationError> {
  try {
    await action;
  } catch (error) {
    assert.ok(error instanceof TextGenerationError, '应抛出 TextGenerationError');
    return error;
  }
  assert.fail('应抛出错误');
}

test('启用 Copilot：全部交给 Copilot，不查询千问模型', async () => {
  const { router, copilot, resolved } = createRouter({ copilotEnabled: true, models: [model(1, true)] });
  assert.deepEqual(await router.resolveModel(), COPILOT_INFO);
  assert.equal(await router.countTokens('文本'), 42);
  assert.deepEqual(await router.generate(REQUEST), { from: 'copilot' });
  assert.deepEqual(copilot.calls, ['resolve', 'count', 'generate']);
  assert.deepEqual(resolved, []);
});

test('关闭 Copilot：使用第一个已启用的千问文本模型，输入上限为上下文减去最大输出，token 数按字符估算', async () => {
  const { router, copilot, adapter, resolved } = createRouter({ copilotEnabled: false, models: [model(1, false, 'a'), model(2, true, 'b'), model(3, true, 'c')] });
  assert.deepEqual(await router.resolveModel(), { id: 'fake/b', maxInputTokens: 800 });
  assert.deepEqual(resolved, [2]);
  assert.equal(await router.countTokens('你好 hello'), estimateTokens('你好 hello'));

  const controller = new AbortController();
  assert.deepEqual(await router.generate(REQUEST, { signal: controller.signal }), { from: 'provider' });
  assert.equal(adapter.contexts[0].signal, controller.signal);
  assert.equal(adapter.contexts[0].apiKey, 'sk');
  assert.deepEqual(copilot.calls, []);
});

test('没有解析过时 generate 会先选择引擎；每次 resolveModel 按当前设置重新选择', async () => {
  const { router, copilot, settings } = createRouter({ copilotEnabled: false, models: [model(1, true)] });
  assert.deepEqual(await router.generate(REQUEST), { from: 'provider' });

  settings.copilotEnabled = true;
  await router.resolveModel();
  assert.deepEqual(await router.generate(REQUEST), { from: 'copilot' });
  assert.deepEqual(copilot.calls, ['resolve', 'generate']);
});

test('没有可用引擎：关闭 Copilot 且没有启用文本模型、服务商拒绝或模型已不存在时给出原因', async () => {
  const none = createRouter({ copilotEnabled: false, models: [model(1, false)] });
  const unavailable = await rejectedWith(none.router.resolveModel());
  assert.deepEqual([unavailable.category, unavailable.message], ['unavailable', NO_TEXT_ENGINE_MESSAGE]);

  const noKey = createRouter({ copilotEnabled: false, models: [model(1, true)], resolveFailure: new ProviderError('auth', '尚未配置访问密钥。') });
  const auth = await rejectedWith(noKey.router.resolveModel());
  assert.deepEqual([auth.category, auth.message], ['not_authorized', '尚未配置访问密钥。']);

  const gone = createRouter({ copilotEnabled: false, models: [model(1, true, 'gone')] });
  assert.equal((await rejectedWith(gone.router.resolveModel())).category, 'unavailable');
});

test('服务商调用失败转换为文本生成错误，保留可读原因；取消转换为已取消', async () => {
  const cases: Array<[unknown, string]> = [
    [new ProviderError('auth', 'a'), 'not_authorized'],
    [new ProviderError('rate_limited', 'r'), 'rate_limited'],
    [new ProviderError('content_rejected', 'c'), 'refused'],
    [new ProviderError('invalid_request', 'i'), 'failed'],
    [new ProviderError('server', 's'), 'unavailable'],
    [new ProviderError('network', 'n'), 'unavailable'],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), 'canceled'],
    [new Error('boom'), 'failed']
  ];
  for (const [failure, category] of cases) {
    const { router, adapter } = createRouter({ copilotEnabled: false, models: [model(1, true)] });
    adapter.failure = failure;
    const error = await rejectedWith(router.generate(REQUEST));
    assert.equal(error.category, category);
    if (failure instanceof ProviderError) {
      assert.equal(error.message, failure.message);
    }
  }
});
