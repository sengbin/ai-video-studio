// ------------------------------------------------------------------------
// 名称：text-generation-router.test.ts
// 说明：文本生成路由的自动化测试：作品选择、全局默认、第一个可用模型的回退顺序，Copilot 没有可用模型时回退到服务商文本模型，Copilot 与服务商文本模型的路由，没有可用模型时的错误，服务商失败转换为文本生成错误，不同作品互不影响。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用假的 Copilot 端口与假的文本适配器，不依赖 VS Code 与网络。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError, TextGenerationError } from '../../domain/errors';
import { TextCapability } from '../../domain/models/model-capability';
import { ModelRecord, UsableModel } from '../../domain/models/model-provider';
import { ProviderCallContext, ResolvedTextCall, TextModelProvider } from '../../domain/ports/provider-adapters';
import { TextGenerationPort, TextGenerationRequest, TextModelInfo } from '../../domain/ports/text-generation-port';
import { estimateTokens } from '../../domain/rules/token-estimate';
import { NO_PROVIDER_FALLBACK_NOTE, NO_TEXT_ENGINE_MESSAGE, TextGenerationRouter } from './text-generation-router';

const CAPABILITY: TextCapability = { contextTokens: 1000, maxOutputTokens: 200, imageInput: true };
const REQUEST: TextGenerationRequest = { system: 's', user: 'u', tool: { name: 't', description: 'd', inputSchema: { type: 'object' } } };

/** 假 Copilot 端口：记录调用与所用的家族。 */
class FakeCopilot implements TextGenerationPort {
  constructor(readonly family: string, private readonly calls: string[], private readonly failure?: Error) {}

  async resolveModel(): Promise<TextModelInfo> {
    this.calls.push(`resolve:${this.family}`);
    if (this.failure !== undefined) throw this.failure;
    return { id: `copilot/${this.family || 'auto'}`, maxInputTokens: 5000 };
  }

  async countTokens(): Promise<number> {
    this.calls.push('count');
    return 42;
  }

  async generate(): Promise<unknown> {
    this.calls.push(`generate:${this.family}`);
    return { from: `copilot:${this.family}` };
  }
}

/** 假文本适配器：返回预设结果或抛出预设错误，记录收到的上下文与模型代码。 */
class FakeTextAdapter implements TextModelProvider {
  readonly kind = 'text';
  readonly provider = { code: 'fake', displayName: '假服务商', settingFields: [] };
  readonly contexts: ProviderCallContext[] = [];
  readonly modelCodes: string[] = [];
  failure: unknown = undefined;

  listModels() {
    return [];
  }

  getCapability(modelCode: string): TextCapability | undefined {
    return modelCode === 'gone' ? undefined : CAPABILITY;
  }

  async generate(modelCode: string, _request: TextGenerationRequest, context: ProviderCallContext): Promise<unknown> {
    this.modelCodes.push(modelCode);
    this.contexts.push(context);
    if (this.failure !== undefined) throw this.failure;
    return { from: `provider:${modelCode}` };
  }
}

function usable(id: number, code: string): UsableModel {
  const model = { id, providerId: 1, code, displayName: code, kind: 'text', isEnabled: true, capability: CAPABILITY, createdAt: '' } as ModelRecord;
  return { model, providerCode: 'fake', providerName: '假服务商' };
}

interface Options {
  copilotEnabled?: boolean;
  defaultModel?: string;
  models?: UsableModel[];
  workModels?: Record<number, string>;
  resolveFailure?: unknown;
  /** 按家族返回 Copilot 解析时的失败；返回 undefined 表示该家族可用。 */
  copilotFailure?: (family: string) => Error | undefined;
}

function createRouter(options: Options = {}) {
  const calls: string[] = [];
  const adapter = new FakeTextAdapter();
  const settings = { copilotEnabled: options.copilotEnabled ?? true, defaultModel: options.defaultModel ?? 'copilot:', novelSplit: { mode: 'chapter' as const, maxSegmentChars: 20000 } };
  const resolved: number[] = [];
  const models = options.models ?? [];
  const router = new TextGenerationRouter({
    settings: { read: () => settings },
    createCopilot: (family) => new FakeCopilot(family, calls, options.copilotFailure?.(family)),
    providers: {
      listSelectableTextModels: () => models,
      resolveTextCall: async (modelId): Promise<ResolvedTextCall> => {
        resolved.push(modelId);
        if (options.resolveFailure !== undefined) throw options.resolveFailure;
        const code = models.find((item) => item.model.id === modelId)?.model.code ?? 'm';
        return { adapter, modelCode: code, context: { apiKey: 'sk', settings: {} } };
      }
    },
    workModels: { find: (workId) => options.workModels?.[workId] ?? null }
  });
  return { router, calls, adapter, settings, resolved };
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

test('默认是 Copilot 的某个家族：交给 Copilot，不查询服务商模型', async () => {
  const { router, calls, resolved } = createRouter({ defaultModel: 'copilot:gpt-4o', models: [usable(1, 'a')] });
  const port = router.forWork(null);
  assert.deepEqual(await port.resolveModel(), { id: 'copilot/gpt-4o', maxInputTokens: 5000 });
  assert.equal(await port.countTokens('文本'), 42);
  assert.deepEqual(await port.generate(REQUEST), { from: 'copilot:gpt-4o' });
  assert.deepEqual(calls, ['resolve:gpt-4o', 'count', 'generate:gpt-4o']);
  assert.deepEqual(resolved, []);
});

test('默认是服务商文本模型：输入上限为上下文减去最大输出，token 数按字符估算，取消信号与密钥一并传给适配器', async () => {
  const { router, calls, adapter } = createRouter({ defaultModel: 'model:fake/b', models: [usable(1, 'a'), usable(2, 'b')] });
  const port = router.forWork(null);
  assert.deepEqual(await port.resolveModel(), { id: 'fake/b', maxInputTokens: 800 });
  assert.equal(await port.countTokens('你好 hello'), estimateTokens('你好 hello'));

  const controller = new AbortController();
  assert.deepEqual(await port.generate(REQUEST, { signal: controller.signal }), { from: 'provider:b' });
  assert.equal(adapter.contexts[0].signal, controller.signal);
  assert.equal(adapter.contexts[0].apiKey, 'sk');
  assert.deepEqual(calls, []);
});

test('作品的选择优先于全局默认，不同作品互不影响，没有选择的作品和资产提示词用全局默认', async () => {
  const { router } = createRouter({
    defaultModel: 'copilot:',
    models: [usable(1, 'a')],
    workModels: { 1: 'model:fake/a', 2: 'copilot:gpt-4o' }
  });
  const one = router.forWork(1);
  const two = router.forWork(2);
  const three = router.forWork(3);
  const global = router.forWork(null);
  await Promise.all([one.resolveModel(), two.resolveModel(), three.resolveModel(), global.resolveModel()]);
  assert.deepEqual(await Promise.all([one, two, three, global].map((port) => port.generate(REQUEST))), [
    { from: 'provider:a' },
    { from: 'copilot:gpt-4o' },
    { from: 'copilot:' },
    { from: 'copilot:' }
  ]);
});

test('本次指定的模型优先于作品的选择与全局默认，指定的模型已不可用时回退到作品的选择', async () => {
  const { router } = createRouter({ defaultModel: 'copilot:', models: [usable(1, 'a')], workModels: { 1: 'copilot:gpt-4o' } });
  assert.deepEqual(await router.forWork(1, 'model:fake/a').generate(REQUEST), { from: 'provider:a' });
  assert.deepEqual(await router.forWork(null, 'copilot:gpt-4o').generate(REQUEST), { from: 'copilot:gpt-4o' });
  assert.deepEqual(await router.forWork(1, null).generate(REQUEST), { from: 'copilot:gpt-4o' });
  assert.deepEqual(await router.forWork(1, 'model:fake/gone').generate(REQUEST), { from: 'copilot:gpt-4o' });
  assert.deepEqual(await router.forWork(null, 'model:fake/gone').generate(REQUEST), { from: 'copilot:' });
});

test('选择的模型已不可用：作品回退到全局默认，默认也不可用时回退到第一个可用模型', async () => {
  // 作品选了已被停用的服务商模型 → 全局默认。
  const stopped = createRouter({ defaultModel: 'copilot:gpt-4o', models: [], workModels: { 1: 'model:fake/a' } });
  assert.deepEqual(await stopped.router.forWork(1).generate(REQUEST), { from: 'copilot:gpt-4o' });

  // Copilot 已关闭：作品与默认选的 Copilot 都不可用 → 第一个可用的服务商模型。
  const off = createRouter({ copilotEnabled: false, defaultModel: 'copilot:gpt-4o', models: [usable(1, 'a'), usable(2, 'b')], workModels: { 1: 'copilot:' } });
  assert.deepEqual(await off.router.forWork(1).generate(REQUEST), { from: 'provider:a' });

  // 默认选的服务商模型已停用，Copilot 可用 → Copilot 自动。
  const copilot = createRouter({ defaultModel: 'model:fake/gone', models: [usable(1, 'a')] });
  assert.deepEqual(await copilot.router.forWork(null).generate(REQUEST), { from: 'copilot:' });
});

test('Copilot 开着但没有可用模型：回退到第一个可用的服务商文本模型，不再先选 Copilot 导致失败；Copilot 有模型时仍优先 Copilot 自动', async () => {
  const noModels = new TextGenerationError('unavailable', '没有可用的 Copilot 模型。');
  // 默认是 Copilot 自动、没有可用模型 → 服务商模型。
  const auto = createRouter({ defaultModel: 'copilot:', models: [usable(1, 'a'), usable(2, 'b')], copilotFailure: () => noModels });
  const port = auto.router.forWork(null);
  assert.deepEqual(await port.resolveModel(), { id: 'fake/a', maxInputTokens: 800 });
  assert.deepEqual(await port.generate(REQUEST), { from: 'provider:a' });
  assert.deepEqual(auto.calls, ['resolve:'], 'Copilot 自动只探测一次，不重复');

  // 作品选的家族不存在 → 默认（服务商模型）。
  const missingFamily = createRouter({
    defaultModel: 'model:fake/b',
    models: [usable(1, 'a'), usable(2, 'b')],
    workModels: { 1: 'copilot:gone' },
    copilotFailure: (family) => (family === 'gone' ? noModels : undefined)
  });
  assert.deepEqual(await missingFamily.router.forWork(1).generate(REQUEST), { from: 'provider:b' });

  // 默认选的家族不存在，Copilot 自动可用 → Copilot 自动。
  const toAuto = createRouter({ defaultModel: 'copilot:gone', models: [usable(1, 'a')], copilotFailure: (family) => (family === 'gone' ? noModels : undefined) });
  assert.deepEqual(await toAuto.router.forWork(null).generate(REQUEST), { from: 'copilot:' });
  assert.deepEqual(toAuto.calls, ['resolve:gone', 'resolve:', 'generate:']);
});

test('Copilot 没有可用模型且没有服务商文本模型：给出明确的不可用错误；授权、限流等其他 Copilot 错误不回退', async () => {
  const noModels = new TextGenerationError('unavailable', '没有可用的 Copilot 模型。');
  const none = createRouter({ copilotFailure: () => noModels });
  const error = await rejectedWith(none.router.forWork(null).resolveModel());
  assert.equal(error.category, 'unavailable');
  assert.ok(error.message.startsWith('没有可用的 Copilot 模型。'));
  assert.ok(error.message.includes(NO_PROVIDER_FALLBACK_NOTE));

  for (const category of ['not_authorized', 'rate_limited', 'failed'] as const) {
    const failing = createRouter({ models: [usable(1, 'a')], copilotFailure: () => new TextGenerationError(category, '原因') });
    const rejected = await rejectedWith(failing.router.forWork(null).resolveModel());
    assert.deepEqual([rejected.category, rejected.message], [category, '原因']);
    assert.deepEqual(failing.resolved, [], '这些错误不回退到服务商模型');
  }
});

test('每次 resolveModel 按当时的设置重新选择，没有解析过时 generate 会先选择', async () => {
  const { router, settings } = createRouter({ defaultModel: 'model:fake/a', models: [usable(1, 'a')] });
  const port = router.forWork(null);
  assert.deepEqual(await port.generate(REQUEST), { from: 'provider:a' });

  settings.defaultModel = 'copilot:';
  await port.resolveModel();
  assert.deepEqual(await port.generate(REQUEST), { from: 'copilot:' });
});

test('没有可用模型：Copilot 已关闭且没有启用的文本模型、服务商拒绝或模型已不存在时给出原因', async () => {
  const none = createRouter({ copilotEnabled: false, models: [] });
  const unavailable = await rejectedWith(none.router.forWork(null).resolveModel());
  assert.deepEqual([unavailable.category, unavailable.message], ['unavailable', NO_TEXT_ENGINE_MESSAGE]);

  const noKey = createRouter({ defaultModel: 'model:fake/a', models: [usable(1, 'a')], resolveFailure: new ProviderError('auth', '尚未配置访问密钥。') });
  const auth = await rejectedWith(noKey.router.forWork(null).resolveModel());
  assert.deepEqual([auth.category, auth.message], ['not_authorized', '尚未配置访问密钥。']);

  const gone = createRouter({ defaultModel: 'model:fake/gone', models: [usable(1, 'gone')] });
  assert.equal((await rejectedWith(gone.router.forWork(null).resolveModel())).category, 'unavailable');
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
    const { router, adapter } = createRouter({ defaultModel: 'model:fake/a', models: [usable(1, 'a')] });
    adapter.failure = failure;
    const error = await rejectedWith(router.forWork(null).generate(REQUEST));
    assert.equal(error.category, category);
    if (failure instanceof ProviderError) {
      assert.equal(error.message, failure.message);
    }
  }
});
