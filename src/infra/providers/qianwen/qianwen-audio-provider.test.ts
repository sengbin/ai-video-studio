// ------------------------------------------------------------------------
// 名称：qianwen-audio-provider.test.ts
// 说明：千问AI平台音频适配器的自动化测试：模型声明、请求校验、两个同步接口的请求体构造、结果编码进任务引用、错误分类。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：注入假的 fetch，不访问网络；请求体与响应字段对照“音频生成 API参考”“音乐生成（Fun-Music）”。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../../domain/errors';
import { AudioGenerationRequest, MediaInput, ProviderCallContext } from '../../../domain/ports/provider-adapters';
import { QianwenAudioProvider } from './qianwen-audio-provider';
import { FakeResponse, createFakeFetch } from './testing/fake-fetch';

const CONTEXT: ProviderCallContext = { apiKey: 'sk-test', settings: { endpoint: 'https://api.test/api/v1' } };

function createProvider(responses: FakeResponse[] = []) {
  const { fetchFunction, calls } = createFakeFetch(responses);
  return { calls, provider: new QianwenAudioProvider(fetchFunction) };
}

function media(mimeType = 'audio/wav', size = 4): MediaInput {
  return { mimeType, data: new Uint8Array(size).fill(1) };
}

/** 语音模型的最简合法请求，测试按需覆盖字段。 */
function speech(overrides: Partial<AudioGenerationRequest> = {}): AudioGenerationRequest {
  return {
    modelCode: 'qwen-audio-3.1-tts-next',
    audioKind: 'voice',
    prompt: '一位女性清晰地说：“你好，欢迎使用。”',
    durationSeconds: null,
    language: null,
    voice: null,
    referenceAudio: null,
    extraParams: {},
    ...overrides
  };
}

/** 音乐模型的最简合法请求。 */
function music(overrides: Partial<AudioGenerationRequest> = {}): AudioGenerationRequest {
  return speech({ modelCode: 'fun-music-v1', audioKind: 'music', prompt: '夏日清新民谣，木吉他与口琴伴奏', ...overrides });
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

test('适配器声明：两个模型及能力', () => {
  const { provider } = createProvider();
  assert.deepEqual(provider.listModels().map((model) => model.code), ['qwen-audio-3.1-tts-next', 'fun-music-v1']);
  assert.deepEqual(provider.getCapability('qwen-audio-3.1-tts-next')?.audioKinds, ['voice', 'sfx']);
  assert.equal(provider.getCapability('qwen-audio-3.1-tts-next')?.referenceAudio, true);
  assert.deepEqual(provider.getCapability('fun-music-v1')?.audioKinds, ['music']);
  assert.equal(provider.getCapability('fun-music-v1')?.referenceAudio, false);
  assert.equal(provider.getCapability('nope'), undefined);
  assert.equal('cancel' in provider, false);
  assert.equal(provider.provider.code, 'qianwen');
});

test('校验：合法请求没有问题；类型、提示词、时长、语言、音色超出能力时逐条指出', () => {
  const { provider } = createProvider();
  assert.deepEqual(provider.validate(speech()), []);
  assert.deepEqual(provider.validate(speech({ audioKind: 'sfx', language: 'en' })), []);
  assert.deepEqual(provider.validate(music()), []);

  assert.match(provider.validate(speech({ audioKind: 'music' })).join(), /不能生成music类型/);
  assert.match(provider.validate(music({ audioKind: 'voice' })).join(), /不能生成voice类型/);
  assert.match(provider.validate(speech({ prompt: ' ' })).join(), /提示词不能为空/);
  assert.match(provider.validate(speech({ prompt: 'x'.repeat(3001) })).join(), /不能超过 3000 字/);
  assert.match(provider.validate(music({ prompt: 'x'.repeat(2001) })).join(), /不能超过 2000 字/);
  assert.match(provider.validate(speech({ durationSeconds: 10 })).join(), /不支持指定时长/);
  assert.match(provider.validate(speech({ language: 'ja' })).join(), /语言 ja/);
  assert.match(provider.validate(speech({ voice: 'Cherry' })).join(), /不支持预置音色 Cherry/);
  assert.deepEqual(provider.validate(speech({ modelCode: 'x' })), ['千问AI平台没有模型 x。']);
});

test('校验：参考音频只有语音模型支持，类型与大小受限，提示词必须用 @voice1 引用', () => {
  const { provider } = createProvider();
  const prompt = '@voice1 用开心的语气说：“今天天气真好。”';
  assert.deepEqual(provider.validate(speech({ prompt, referenceAudio: media() })), []);
  assert.match(provider.validate(speech({ referenceAudio: media() })).join(), /用 @voice1 引用参考音频/);
  assert.match(provider.validate(speech({ prompt, referenceAudio: media('image/png') })).join(), /类型必须以 audio\/ 开头/);
  assert.match(provider.validate(speech({ prompt, referenceAudio: media('audio/wav', 0) })).join(), /大小必须在 1 字节到 10 MB/);
  assert.match(provider.validate(music({ referenceAudio: media() })).join(), /不支持参考音频/);
});

test('校验：模型专有参数按模型区分，取值必须在允许范围内', () => {
  const { provider } = createProvider();
  assert.deepEqual(provider.validate(speech({ extraParams: { format: 'mp3' } })), []);
  assert.match(provider.validate(speech({ extraParams: { format: 'pcm' } })).join(), /format 必须是以下之一：wav、mp3/);
  assert.match(provider.validate(speech({ extraParams: { gender: 'male' } })).join(), /不支持的模型参数：gender/);
  assert.deepEqual(provider.validate(music({ extraParams: { format: 'wav', instrumental: true, gender: 'male' } })), []);
  assert.match(provider.validate(music({ extraParams: { instrumental: 'yes' } })).join(), /必须是开或关/);
  assert.match(provider.validate(music({ extraParams: { gender: 'other' } })).join(), /gender 必须是以下之一/);
});

test('提交：语音接口——text_prompt 与 Base64 参考音频，结果编码进任务引用，查询直接成功', async () => {
  const { calls, provider } = createProvider([
    { body: { request_id: 'r', output: { finish_reason: 'stop', audio: { data: '', url: 'https://oss.test/a.wav', id: 'a', expires_at: 1, duration: 1.12 } }, usage: { duration: 1 } } }
  ]);
  const prompt = '@voice1 说：“你好。”';
  const ref = await provider.submit(speech({ prompt, referenceAudio: { mimeType: 'audio/wav', data: new Uint8Array([1, 2, 3]) }, extraParams: { format: 'mp3' } }), CONTEXT);

  const [call] = calls;
  assert.equal(call.url, 'https://api.test/api/v1/services/audio/tts/SpeechSynthesizer');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.headers['X-DashScope-Async'], undefined, '音频接口是同步的');
  assert.deepEqual(call.body, {
    model: 'qwen-audio-3.1-tts-next',
    input: { text_prompt: prompt, references: [{ audio_data: `data:audio/wav;base64,${Buffer.from([1, 2, 3]).toString('base64')}` }], format: 'mp3' }
  });

  assert.equal(ref.modelCode, 'qwen-audio-3.1-tts-next');
  assert.deepEqual(await provider.query(ref), {
    status: 'succeeded',
    result: { audioUrl: 'https://oss.test/a.wav', durationSeconds: 1.12 },
    errorCategory: null,
    errorCode: null,
    errorMessage: null
  });
  assert.equal(calls.length, 1, '查询不再发请求');
});

test('提交：音乐接口——prompt 与专有参数写入 input，时长取自 usage', async () => {
  const { calls, provider } = createProvider([{ body: { output: { audio: { url: 'https://oss.test/m.mp3' }, finish_reason: 'stop' }, usage: { duration: 200 } } }]);
  const ref = await provider.submit(music({ extraParams: { instrumental: true, gender: 'male' } }), CONTEXT);

  assert.equal(calls[0].url, 'https://api.test/api/v1/services/audio/music/generation');
  assert.deepEqual(calls[0].body, {
    model: 'fun-music-v1',
    input: { prompt: '夏日清新民谣，木吉他与口琴伴奏', is_instrumental: true, gender: 'male' }
  });
  assert.deepEqual((await provider.query(ref)).result, { audioUrl: 'https://oss.test/m.mp3', durationSeconds: 200 });
});

test('提交：校验不通过时不发请求，没有音频地址时报服务端错误', async () => {
  const invalid = createProvider();
  const error = await rejectedWith(invalid.provider.submit(speech({ prompt: '' }), CONTEXT));
  assert.equal(error.category, 'invalid_request');
  assert.equal(invalid.calls.length, 0);

  const noUrl = createProvider([{ body: { output: { audio: { url: '' } } } }]);
  assert.equal((await rejectedWith(noUrl.provider.submit(speech(), CONTEXT))).category, 'server');
});

test('提交：HTTP 错误按状态和错误码分类（含音频接口的 CLIENT_ERROR），错误信息不含密钥；网络故障为 network', async () => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [401, { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 'auth', false],
    [403, { code: 'AccessDenied', message: 'model access denied' }, 'auth', false],
    [429, { code: 'Throttling.RateQuota', message: 'limit' }, 'rate_limited', true],
    [400, { code: 'DataInspectionFailed', message: 'bad content' }, 'content_rejected', false],
    [400, { code: 'CLIENT_ERROR', message: 'text_prompt exceeds the maximum length of 3000 characters.' }, 'invalid_request', false],
    [500, { code: 'InternalError', message: 'internal' }, 'server', true]
  ];
  for (const [status, body, category, retryable] of cases) {
    const { provider } = createProvider([{ status, body }]);
    const error = await rejectedWith(provider.submit(speech(), CONTEXT));
    assert.equal(error.category, category, `${status} ${JSON.stringify(body)}`);
    assert.equal(error.retryable, retryable);
    assert.ok(!error.message.includes('sk-test'));
  }
  const failing = createProvider([new TypeError('fetch failed')]);
  assert.equal((await rejectedWith(failing.provider.submit(speech(), CONTEXT))).category, 'network');
});

test('查询：任务引用损坏时报参数错误', async () => {
  const { provider } = createProvider();
  const error = await rejectedWith(provider.query({ modelCode: 'fun-music-v1', remoteJobId: 'not-json' }));
  assert.equal(error.category, 'invalid_request');
  await rejectedWith(provider.query({ modelCode: 'fun-music-v1', remoteJobId: '{}' }));
});
