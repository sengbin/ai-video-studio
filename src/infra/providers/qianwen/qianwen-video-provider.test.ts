// ------------------------------------------------------------------------
// 名称：qianwen-video-provider.test.ts
// 说明：千问AI平台万相 3.0 视频适配器的自动化测试：请求校验、请求体构造、任务提交与查询、各类错误的分类。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：注入假的 fetch，不访问网络；请求体与响应字段对照 wan3.0-video 的 API 参考。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../../domain/errors';
import { MediaInput, ProviderCallContext, VideoGenerationRequest } from '../../../domain/ports/provider-adapters';
import { QianwenVideoProvider } from './qianwen-video-provider';

const CONTEXT: ProviderCallContext = { apiKey: 'sk-test', settings: { endpoint: 'https://api.test/v1' } };

/** 一次记录下来的网络请求。 */
interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

/** 创建按顺序返回预设响应的假 fetch，并记录每次调用。 */
function createFakeFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: RecordedCall[] = [];
  const fetchFunction = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('没有预设的响应');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { calls, provider: new QianwenVideoProvider(fetchFunction) };
}

function media(mimeType: string, size = 4): MediaInput {
  return { mimeType, data: new Uint8Array(size).fill(1) };
}

/** 一个最简合法请求，测试按需覆盖字段。 */
function request(overrides: Partial<VideoGenerationRequest> = {}): VideoGenerationRequest {
  return {
    modelCode: 'wan3.0-video',
    prompt: '一只猫在奔跑',
    firstFrame: null,
    lastFrame: null,
    referenceImages: [],
    referenceAudios: [],
    aspectRatio: null,
    resolution: null,
    durationSeconds: null,
    audioMode: null,
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

test('适配器声明：模型清单与能力', () => {
  const { provider } = createFakeFetch([]);
  assert.deepEqual(provider.listModels().map((model) => model.code), ['wan3.0-video', 'wan3.0-video-prime']);
  assert.equal(provider.getCapability('wan3.0-video')?.duration.max, 30);
  assert.equal(provider.getCapability('nope'), undefined);
  assert.equal('cancel' in provider, false, '平台文档没有取消接口');
  assert.equal(provider.provider.code, 'qianwen');
});

test('校验：合法请求没有问题；画幅、分辨率、时长、声音、种子超出能力时逐条指出', () => {
  const { provider } = createFakeFetch([]);
  assert.deepEqual(provider.validate(request()), []);
  assert.deepEqual(provider.validate(request({ aspectRatio: '16:9', resolution: '720P', durationSeconds: 30, audioMode: 'none', seed: 0 })), []);
  assert.deepEqual(provider.validate(request({ durationSeconds: -1 })), [], '智能时长');

  const issues = provider.validate(request({ aspectRatio: '5:4', resolution: '4K', durationSeconds: 31, seed: -5 }));
  assert.equal(issues.length, 4);
  assert.ok(provider.validate(request({ durationSeconds: 1 })).length === 1);
  assert.deepEqual(provider.validate(request({ modelCode: 'x' })), ['千问AI平台没有模型 x。']);
});

test('校验：素材组合——尾帧须配首帧，首尾帧与参考素材互斥，提示词与素材至少一项', () => {
  const { provider } = createFakeFetch([]);
  const png = media('image/png');
  assert.deepEqual(provider.validate(request({ firstFrame: png })), []);
  assert.deepEqual(provider.validate(request({ firstFrame: png, lastFrame: png })), []);
  assert.deepEqual(provider.validate(request({ referenceImages: [png], referenceAudios: [media('audio/mpeg')] })), []);
  assert.match(provider.validate(request({ lastFrame: png })).join(), /同时指定首帧/);
  assert.match(provider.validate(request({ firstFrame: png, referenceImages: [png] })).join(), /不能与参考图/);
  assert.match(provider.validate(request({ prompt: '  ' })).join(), /至少要提供一项/);
  assert.deepEqual(provider.validate(request({ prompt: '', firstFrame: png })), [], '只有素材也可以');
});

test('校验：素材数量、类型与大小', () => {
  const { provider } = createFakeFetch([]);
  const png = media('image/png');
  assert.match(provider.validate(request({ referenceImages: Array(11).fill(png) })).join(), /参考图最多 10 张/);
  assert.match(provider.validate(request({ referenceAudios: Array(6).fill(media('audio/wav')) })).join(), /参考音频最多 5 段/);
  assert.match(provider.validate(request({ firstFrame: media('audio/wav') })).join(), /类型必须以 image\/ 开头/);
  assert.match(provider.validate(request({ referenceAudios: [media('image/png')] })).join(), /类型必须以 audio\/ 开头/);
  assert.match(provider.validate(request({ firstFrame: media('image/png', 0) })).join(), /大小必须在/);
  assert.match(provider.validate(request({ prompt: 'x'.repeat(20001) })).join(), /不能超过 20000 字/);
});

test('校验：模型专有参数只允许已知的键且必须是布尔值', () => {
  const { provider } = createFakeFetch([]);
  assert.deepEqual(provider.validate(request({ extraParams: { promptExtend: false, watermark: true } })), []);
  assert.match(provider.validate(request({ extraParams: { unknown: true } })).join(), /不支持的模型参数：unknown/);
  assert.match(provider.validate(request({ extraParams: { watermark: 'yes' } })).join(), /必须是开或关/);
});

test('提交：构造请求体与请求头，素材以 Base64 内联，返回任务引用', async () => {
  const { calls, provider } = createFakeFetch([{ body: { request_id: 'r', output: { task_id: 'T-1', task_status: 'PENDING' } } }]);
  const first = { mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) };
  const ref = await provider.submit(
    request({ firstFrame: first, aspectRatio: '9:16', resolution: '720P', durationSeconds: 8, audioMode: 'native', seed: 7, extraParams: { promptExtend: false } }),
    CONTEXT
  );

  assert.deepEqual(ref, { modelCode: 'wan3.0-video', remoteJobId: 'T-1' });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, 'https://api.test/v1/services/aigc/video-generation/video-synthesis');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.headers['X-DashScope-Async'], 'enable');
  assert.deepEqual(call.body, {
    model: 'wan3.0-video',
    input: { prompt: '一只猫在奔跑', media: [{ type: 'first_frame', url: `data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}` }] },
    parameters: { resolution: '720P', ratio: '9:16', duration: 8, audio: true, seed: 7, prompt_extend: false }
  });
});

test('提交：参考图与参考音频按顺序写入；未指定的参数不写入，智能时长透传 -1', async () => {
  const { calls, provider } = createFakeFetch([{ body: { output: { task_id: 'T-2', task_status: 'PENDING' } } }]);
  await provider.submit(request({ referenceImages: [media('image/jpeg'), media('image/png')], referenceAudios: [media('audio/mpeg')], durationSeconds: -1, audioMode: 'none' }), CONTEXT);
  const body = calls[0].body as { input: { media: Array<{ type: string }> }; parameters: Record<string, unknown> };
  assert.deepEqual(body.input.media.map((item) => item.type), ['reference_image', 'reference_image', 'reference_audio']);
  assert.deepEqual(body.parameters, { duration: -1, audio: false });
});

test('提交：校验不通过时不发请求，以参数错误抛出', async () => {
  const { calls, provider } = createFakeFetch([]);
  const error = await rejectedWith(provider.submit(request({ resolution: '4K' }), CONTEXT));
  assert.equal(error.category, 'invalid_request');
  assert.equal(error.retryable, false);
  assert.equal(calls.length, 0);
});

test('提交：没有任务标识、没有接口地址时报错', async () => {
  const noTask = createFakeFetch([{ body: { output: {} } }]);
  assert.equal((await rejectedWith(noTask.provider.submit(request(), CONTEXT))).category, 'server');
  const noEndpoint = createFakeFetch([]);
  const error = await rejectedWith(noEndpoint.provider.submit(request(), { apiKey: 'k', settings: {} }));
  assert.match(error.message, /接口地址/);
});

test('提交：HTTP 错误按状态和错误码分类，错误信息不含密钥', async () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 'auth', false],
    [429, { code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded' }, 'rate_limited', true],
    [400, { code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, 'content_rejected', false],
    [400, { code: 'InvalidParameter', message: 'bad' }, 'invalid_request', false],
    [500, { message: 'internal' }, 'server', true],
    [403, {}, 'auth', false]
  ];
  for (const [status, body, category, retryable] of cases) {
    const { provider } = createFakeFetch([{ status, body }]);
    const error = await rejectedWith(provider.submit(request(), CONTEXT));
    assert.equal(error.category, category, `${status} ${JSON.stringify(body)}`);
    assert.equal(error.retryable, retryable);
    assert.ok(!error.message.includes('sk-test'));
  }
});

test('提交：网络故障分类为 network，主动取消原样抛出', async () => {
  const failing = createFakeFetch([new TypeError('fetch failed')]);
  const error = await rejectedWith(failing.provider.submit(request(), CONTEXT));
  assert.equal(error.category, 'network');
  assert.equal(error.retryable, true);

  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const aborted = createFakeFetch([abort]);
  await assert.rejects(() => aborted.provider.submit(request(), CONTEXT), (thrown) => thrown === abort);
});

test('查询：各状态映射为统一状态；成功带视频地址与时长', async () => {
  const { calls, provider } = createFakeFetch([
    { body: { output: { task_id: 'T', task_status: 'PENDING' } } },
    { body: { output: { task_id: 'T', task_status: 'RUNNING' } } },
    { body: { output: { task_status: 'SUCCEEDED', video_url: 'https://oss.test/v.mp4' }, usage: { output_video_duration: 5 } } },
    { body: { output: { task_status: 'CANCELED' } } },
    { body: { output: { task_status: 'UNKNOWN' } } }
  ]);
  const ref = { modelCode: 'wan3.0-video', remoteJobId: 'T/1' };

  assert.equal((await provider.query(ref, CONTEXT)).status, 'pending');
  assert.equal((await provider.query(ref, CONTEXT)).status, 'running');
  assert.deepEqual(await provider.query(ref, CONTEXT), {
    status: 'succeeded',
    result: { videoUrl: 'https://oss.test/v.mp4', durationSeconds: 5 },
    errorCategory: null,
    errorCode: null,
    errorMessage: null
  });
  assert.equal((await provider.query(ref, CONTEXT)).status, 'canceled');
  assert.equal((await provider.query(ref, CONTEXT)).status, 'expired');
  assert.equal(calls[0].url, 'https://api.test/v1/tasks/T%2F1', '任务标识需要转义');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].body, null);
});

test('查询：任务失败时带错误分类、错误码和说明，不抛出', async () => {
  const { provider } = createFakeFetch([
    { body: { output: { task_status: 'FAILED', code: 'DataInspectionFailed', message: '内容不合规' } } },
    { body: { output: { task_status: 'FAILED', code: 'InternalError', message: '服务异常' } } }
  ]);
  const ref = { modelCode: 'wan3.0-video', remoteJobId: 'T' };
  assert.deepEqual(await provider.query(ref, CONTEXT), { status: 'failed', result: null, errorCategory: 'content_rejected', errorCode: 'DataInspectionFailed', errorMessage: '内容不合规' });
  assert.equal((await provider.query(ref, CONTEXT)).errorCategory, 'server');
});

test('查询：状态无法识别、成功却没有视频地址时报服务端错误', async () => {
  const ref = { modelCode: 'wan3.0-video', remoteJobId: 'T' };
  const weird = createFakeFetch([{ body: { output: { task_status: 'WEIRD' } } }]);
  assert.equal((await rejectedWith(weird.provider.query(ref, CONTEXT))).category, 'server');
  const noUrl = createFakeFetch([{ body: { output: { task_status: 'SUCCEEDED' } } }]);
  assert.equal((await rejectedWith(noUrl.provider.query(ref, CONTEXT))).category, 'server');
});
