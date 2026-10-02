// ------------------------------------------------------------------------
// 名称：qianwen-image-provider.test.ts
// 说明：千问AI平台图像适配器的自动化测试：模型声明、请求校验、请求体构造（尺寸换算）、任务提交与查询、测试连接、错误分类。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：注入假的 fetch，不访问网络；请求体与响应字段对照千问图像 3.0 异步接口与万相 2.7 创建、查询任务的 API 参考。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../../domain/errors';
import { ImageGenerationRequest, MediaInput, ProviderCallContext } from '../../../domain/ports/provider-adapters';
import { QianwenImageProvider } from './qianwen-image-provider';
import { FakeResponse, createFakeFetch } from './testing/fake-fetch';

const CONTEXT: ProviderCallContext = { apiKey: 'sk-test', settings: { endpoint: 'https://api.test/api/v1' } };

function createProvider(responses: FakeResponse[] = []) {
  const { fetchFunction, calls } = createFakeFetch(responses);
  return { calls, provider: new QianwenImageProvider(fetchFunction) };
}

function media(mimeType = 'image/png', size = 4): MediaInput {
  return { mimeType, data: new Uint8Array(size).fill(1) };
}

/** 一个最简合法请求，测试按需覆盖字段。 */
function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
  return {
    modelCode: 'qwen-image-3.0-pro',
    prompt: '一只在雨中奔跑的橘猫',
    negativePrompt: null,
    referenceImages: [],
    aspectRatio: null,
    resolution: null,
    count: 1,
    seed: null,
    extraParams: {},
    ...overrides
  };
}

async function rejectedWith(action: Promise<unknown>): Promise<ProviderError> {
  try {
    await action;
  } catch (error) {
    assert.ok(error instanceof ProviderError, '应抛出 ProviderError');
    return error;
  }
  assert.fail('应抛出错误');
}

test('测试连接：查询不存在的任务，带错误码的业务错误说明地址与密钥可用，其他失败按分类报错', async () => {
  const reachable = createProvider([{ status: 400, body: { code: 'InvalidParameter', message: 'task not found' } }]);
  await reachable.provider.checkConnection(CONTEXT);
  assert.deepEqual([reachable.calls[0].method, reachable.calls[0].url], ['GET', 'https://api.test/api/v1/tasks/00000000-0000-0000-0000-000000000000']);
  assert.equal(reachable.calls[0].headers.Authorization, `Bearer ${CONTEXT.apiKey}`);

  await createProvider([{ body: {} }]).provider.checkConnection(CONTEXT);

  const badKey = createProvider([{ status: 401, body: { code: 'InvalidApiKey', message: 'Invalid API-key provided.' } }]);
  assert.equal((await rejectedWith(badKey.provider.checkConnection(CONTEXT))).category, 'auth');

  const wrongPath = createProvider([{ status: 404, body: {} }]);
  const notFound = await rejectedWith(wrongPath.provider.checkConnection(CONTEXT));
  assert.deepEqual([notFound.category, /接口地址是否正确/.test(notFound.message)], ['invalid_request', true]);

  const offline = createProvider([new TypeError('fetch failed')]);
  assert.equal((await rejectedWith(offline.provider.checkConnection(CONTEXT))).category, 'network');
  const server = createProvider([{ status: 500, body: { code: 'InternalError', message: 'x' } }]);
  assert.equal((await rejectedWith(server.provider.checkConnection(CONTEXT))).category, 'server');

  const noEndpoint = createProvider([]);
  assert.match((await rejectedWith(noEndpoint.provider.checkConnection({ apiKey: 'k', settings: {} }))).message, /接口地址/);
  assert.equal(noEndpoint.calls.length, 0);
});

test('适配器声明：四个模型及能力', () => {
  const { provider } = createProvider();
  assert.deepEqual(provider.listModels().map((model) => model.code), ['qwen-image-3.0-pro', 'qwen-image-3.0', 'wan2.7-image-pro', 'wan2.7-image']);
  assert.equal(provider.getCapability('qwen-image-3.0')?.imagesPerRequestMax, 6);
  assert.equal(provider.getCapability('qwen-image-3.0')?.referenceImagesMax, 0);
  assert.equal(provider.getCapability('wan2.7-image')?.referenceImagesMax, 9);
  assert.deepEqual(provider.getCapability('wan2.7-image-pro')?.resolutions, ['1K', '2K', '4K']);
  assert.deepEqual(provider.getCapability('wan2.7-image')?.resolutions, ['1K', '2K']);
  assert.equal(provider.getCapability('nope'), undefined);
  assert.equal('cancel' in provider, false, '平台文档没有取消接口');
  assert.equal(provider.provider.code, 'qianwen');
});

test('校验：合法请求没有问题；提示词、数量、画幅、分辨率、种子超出能力时逐条指出', () => {
  const { provider } = createProvider();
  assert.deepEqual(provider.validate(request()), []);
  assert.deepEqual(provider.validate(request({ aspectRatio: '16:9', resolution: '2K', count: 6, seed: 0, negativePrompt: '模糊' })), []);

  assert.match(provider.validate(request({ prompt: '  ' })).join(), /提示词不能为空/);
  assert.match(provider.validate(request({ prompt: 'x'.repeat(4501) })).join(), /不能超过 4500 字/);
  assert.match(provider.validate(request({ count: 7 })).join(), /1 到 6/);
  assert.match(provider.validate(request({ count: 0 })).join(), /1 到 6/);
  assert.match(provider.validate(request({ aspectRatio: '5:4' })).join(), /画幅 5:4/);
  assert.match(provider.validate(request({ resolution: '4K' })).join(), /分辨率 4K/);
  assert.match(provider.validate(request({ seed: -1 })).join(), /随机种子/);
  assert.match(provider.validate(request({ negativePrompt: 'x'.repeat(501) })).join(), /反向提示词不能超过 500 字/);
  assert.deepEqual(provider.validate(request({ modelCode: 'x' })), ['千问AI平台没有模型 x。']);
});

test('校验：参考图只有万相 2.7 支持，数量、类型、大小受限，4K 只能文生图，不支持反向提示词', () => {
  const { provider } = createProvider();
  assert.match(provider.validate(request({ referenceImages: [media()] })).join(), /不支持参考图/);

  const wan = { modelCode: 'wan2.7-image-pro' };
  assert.deepEqual(provider.validate(request({ ...wan, referenceImages: Array(9).fill(media()), resolution: '2K' })), []);
  assert.match(provider.validate(request({ ...wan, referenceImages: Array(10).fill(media()) })).join(), /参考图最多 9 张/);
  assert.match(provider.validate(request({ ...wan, referenceImages: [media('audio/wav')] })).join(), /类型必须以 image\/ 开头/);
  assert.match(provider.validate(request({ ...wan, referenceImages: [media('image/png', 0)] })).join(), /大小必须在/);
  assert.match(provider.validate(request({ ...wan, referenceImages: [media()], resolution: '4K' })).join(), /只能用于不带参考图的文生图/);
  assert.deepEqual(provider.validate(request({ ...wan, resolution: '4K', count: 4 })), []);
  assert.match(provider.validate(request({ ...wan, count: 5 })).join(), /1 到 4/);
  assert.match(provider.validate(request({ ...wan, negativePrompt: '模糊' })).join(), /不支持反向提示词/);
});

test('校验：模型专有参数按模型区分，只允许已知的键且必须是开或关', () => {
  const { provider } = createProvider();
  assert.deepEqual(provider.validate(request({ extraParams: { promptExtend: false, watermark: true } })), []);
  assert.match(provider.validate(request({ extraParams: { thinkingMode: true } })).join(), /不支持的模型参数：thinkingMode/);
  assert.deepEqual(provider.validate(request({ modelCode: 'wan2.7-image', extraParams: { thinkingMode: false, watermark: false } })), []);
  assert.match(provider.validate(request({ extraParams: { watermark: 'yes' } })).join(), /必须是开或关/);
});

test('提交：千问图像 3.0 构造请求体——画幅与分辨率换算为宽*高，反向提示词与专有参数写入 parameters', async () => {
  const { calls, provider } = createProvider([{ body: { request_id: 'r', output: { task_id: 'T-1', task_status: 'PENDING' } } }]);
  const ref = await provider.submit(
    request({ aspectRatio: '16:9', resolution: '2K', count: 2, seed: 7, negativePrompt: '模糊', extraParams: { promptExtend: false } }),
    CONTEXT
  );

  assert.deepEqual(ref, { modelCode: 'qwen-image-3.0-pro', remoteJobId: 'T-1' });
  const [call] = calls;
  assert.equal(call.url, 'https://api.test/api/v1/services/aigc/image-generation/generation');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.headers['X-DashScope-Async'], 'enable');
  assert.deepEqual(call.body, {
    model: 'qwen-image-3.0-pro',
    input: { messages: [{ role: 'user', content: [{ text: '一只在雨中奔跑的橘猫' }] }] },
    parameters: { n: 2, size: '2720*1536', negative_prompt: '模糊', seed: 7, prompt_extend: false }
  });
});

test('提交：尺寸换算——都不指定时不传 size；只指定分辨率时千问图像用 1:1，万相直接传档位；只指定画幅时用 2K', async () => {
  const responses: FakeResponse[] = Array.from({ length: 4 }, () => ({ body: { output: { task_id: 'T', task_status: 'PENDING' } } }));
  const { calls, provider } = createProvider(responses);
  await provider.submit(request(), CONTEXT);
  await provider.submit(request({ resolution: '1K' }), CONTEXT);
  await provider.submit(request({ modelCode: 'wan2.7-image', resolution: '1K' }), CONTEXT);
  await provider.submit(request({ modelCode: 'wan2.7-image', aspectRatio: '9:16' }), CONTEXT);

  const sizes = calls.map((call) => (call.body?.parameters as Record<string, unknown>).size);
  assert.deepEqual(sizes, [undefined, '1024*1024', '1K', '1536*2720']);
});

test('提交：万相 2.7 的参考图以 Base64 内联，按顺序跟在文本之后', async () => {
  const { calls, provider } = createProvider([{ body: { output: { task_id: 'T-2', task_status: 'PENDING' } } }]);
  await provider.submit(
    request({ modelCode: 'wan2.7-image-pro', referenceImages: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }, media('image/jpeg')], extraParams: { thinkingMode: false } }),
    CONTEXT
  );
  const body = calls[0].body as { input: { messages: Array<{ content: unknown[] }> }; parameters: Record<string, unknown> };
  assert.deepEqual(body.input.messages[0].content, [
    { text: '一只在雨中奔跑的橘猫' },
    { image: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` },
    { image: `data:image/jpeg;base64,${Buffer.from([1, 1, 1, 1]).toString('base64')}` }
  ]);
  assert.deepEqual(body.parameters, { n: 1, thinking_mode: false });
});

test('提交：校验不通过时不发请求，没有任务标识时报服务端错误', async () => {
  const invalid = createProvider();
  const error = await rejectedWith(invalid.provider.submit(request({ count: 99 }), CONTEXT));
  assert.equal(error.category, 'invalid_request');
  assert.equal(invalid.calls.length, 0);

  const noTask = createProvider([{ body: { output: {} } }]);
  assert.equal((await rejectedWith(noTask.provider.submit(request(), CONTEXT))).category, 'server');
});

test('提交：HTTP 错误按状态和错误码分类，错误信息不含密钥；网络故障为 network', async () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 'auth', false],
    [429, { code: 'Throttling.RateQuota', message: 'limit' }, 'rate_limited', true],
    [400, { code: 'DataInspectionFailed', message: 'bad content' }, 'content_rejected', false],
    [500, { message: 'internal' }, 'server', true]
  ];
  for (const [status, body, category, retryable] of cases) {
    const { provider } = createProvider([{ status, body }]);
    const error = await rejectedWith(provider.submit(request(), CONTEXT));
    assert.equal(error.category, category);
    assert.equal(error.retryable, retryable);
    assert.ok(!error.message.includes('sk-test'));
  }
  const failing = createProvider([new TypeError('fetch failed')]);
  assert.equal((await rejectedWith(failing.provider.submit(request(), CONTEXT))).category, 'network');
});

test('查询：各状态映射为统一状态；两种响应格式都能取得图片地址', async () => {
  const { calls, provider } = createProvider([
    { body: { output: { task_status: 'PENDING' } } },
    { body: { output: { task_status: 'RUNNING' } } },
    { body: { output: { task_status: 'SUCCEEDED', choices: [{ message: { content: [{ type: 'image', image: 'https://oss.test/1.png' }] } }, { message: { content: [{ image: 'https://oss.test/2.png' }] } }] } } },
    { body: { output: { task_status: 'SUCCEEDED', results: [{ url: 'https://oss.test/3.png' }, { code: 'X', message: '单张失败' }] } } },
    { body: { output: { task_status: 'CANCELED' } } },
    { body: { output: { task_status: 'UNKNOWN' } } }
  ]);
  const ref = { modelCode: 'wan2.7-image', remoteJobId: 'T/1' };

  assert.equal((await provider.query(ref, CONTEXT)).status, 'pending');
  assert.equal((await provider.query(ref, CONTEXT)).status, 'running');
  assert.deepEqual((await provider.query(ref, CONTEXT)).result, { imageUrls: ['https://oss.test/1.png', 'https://oss.test/2.png'] });
  assert.deepEqual((await provider.query(ref, CONTEXT)).result, { imageUrls: ['https://oss.test/3.png'] });
  assert.equal((await provider.query(ref, CONTEXT)).status, 'canceled');
  assert.equal((await provider.query(ref, CONTEXT)).status, 'expired');
  assert.equal(calls[0].url, 'https://api.test/api/v1/tasks/T%2F1', '任务标识需要转义');
  assert.equal(calls[0].method, 'GET');
});

test('查询：任务失败时带错误分类、错误码和说明，不抛出；状态无法识别或成功却没有图片时报服务端错误', async () => {
  const ref = { modelCode: 'qwen-image-3.0', remoteJobId: 'T' };
  const failed = createProvider([{ body: { output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: '内容不合规' } } }]);
  assert.deepEqual(await failed.provider.query(ref, CONTEXT), { status: 'failed', result: null, errorCategory: 'content_rejected', errorCode: 'DataInspectionFailed', errorMessage: '内容不合规' });

  const weird = createProvider([{ body: { output: { task_status: 'WEIRD' } } }]);
  assert.equal((await rejectedWith(weird.provider.query(ref, CONTEXT))).category, 'server');
  const noImage = createProvider([{ body: { output: { task_status: 'SUCCEEDED' } } }]);
  assert.equal((await rejectedWith(noImage.provider.query(ref, CONTEXT))).category, 'server');
});
