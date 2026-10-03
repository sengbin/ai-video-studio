// ------------------------------------------------------------------------
// 名称：qianwen-text-provider.test.ts
// 说明：千问AI平台文本适配器的自动化测试：模型声明、请求体构造、流式结果拼装、图片输入、截断与错误分类。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：注入假的 fetch，不访问网络；请求体与流式事件字段对照“OpenAI Chat API 参考”“函数调用”。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../../domain/errors';
import { ProviderCallContext } from '../../../domain/ports/provider-adapters';
import { TextGenerationRequest } from '../../../domain/ports/text-generation-port';
import { QianwenTextProvider } from './qianwen-text-provider';
import { FakeResponse, createFakeFetch } from './testing/fake-fetch';

const CONTEXT: ProviderCallContext = { apiKey: 'sk-test', settings: { endpoint: 'https://api.test/api/v1' } };
const MODEL = 'qwen3.8-flash';

const REQUEST: TextGenerationRequest = {
  system: '你是编剧。',
  user: '写一个创意。',
  tool: { name: 'submit_creative', description: '提交创意', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } }
};

function createProvider(responses: FakeResponse[]) {
  const { fetchFunction, calls } = createFakeFetch(responses);
  return { calls, provider: new QianwenTextProvider(fetchFunction) };
}

/** 把若干事件对象写成流式响应文本，以 [DONE] 结束。 */
function stream(...events: unknown[]): FakeResponse {
  const raw = [...events.map((event) => `data: ${JSON.stringify(event)}\n\n`), 'data: [DONE]\n\n'].join('');
  return { body: null, raw };
}

function toolCallChunk(fields: { index?: number; name?: string; args?: string }, finishReason: string | null = null) {
  return {
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: fields.index ?? 0, function: { name: fields.name, arguments: fields.args } }] },
        finish_reason: finishReason
      }
    ]
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

test('模型声明：都是文本模型，支持图片输入，上下文不小于最大输出', () => {
  const { provider } = createProvider([]);
  const models = provider.listModels();
  assert.ok(models.length > 0);
  for (const model of models) {
    assert.equal(model.kind, 'text');
    assert.ok(model.capability.contextTokens > model.capability.maxOutputTokens);
    assert.equal(provider.getCapability(model.code), model.capability);
  }
  assert.equal(provider.getCapability('unknown'), undefined);
});

test('生成：请求发往兼容接口，强制调用输出工具并关闭思考，拼装分片的工具参数', async () => {
  const { provider, calls } = createProvider([
    stream(
      { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
      toolCallChunk({ name: 'submit_creative', args: '{"ti' }),
      toolCallChunk({ args: 'tle":"灯塔' }),
      toolCallChunk({ args: '"}' }, 'stop'),
      { choices: [], usage: { total_tokens: 10 } }
    )
  ]);

  assert.deepEqual(await provider.generate(MODEL, REQUEST, CONTEXT), { title: '灯塔' });

  assert.equal(calls[0].url, 'https://api.test/compatible-mode/v1/chat/completions');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Authorization, `Bearer sk-test`);
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(body.model, MODEL);
  assert.equal(body.stream, true);
  assert.equal(body.enable_thinking, false);
  assert.equal(body.max_tokens, provider.getCapability(MODEL)?.maxOutputTokens);
  assert.deepEqual(body.messages, [
    { role: 'system', content: '你是编剧。' },
    { role: 'user', content: '写一个创意。' }
  ]);
  assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'submit_creative', description: '提交创意', parameters: REQUEST.tool.inputSchema } }]);
  assert.deepEqual(body.tool_choice, { type: 'function', function: { name: 'submit_creative' } });
});

test('生成：带图片时用户段是图片加文字的内容数组，图片以 data 地址发送', async () => {
  const { provider, calls } = createProvider([stream(toolCallChunk({ name: 'submit_creative', args: '{}' }, 'stop'))]);
  await provider.generate(MODEL, { ...REQUEST, images: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }] }, CONTEXT);
  const messages = (calls[0].body as { messages: Array<{ content: unknown }> }).messages;
  assert.deepEqual(messages[1].content, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
    { type: 'text', text: '写一个创意。' }
  ]);
});

test('生成：事件可以在任意位置被拆开，最后一行没有换行也能处理', async () => {
  const events = [toolCallChunk({ name: 'submit_creative', args: '{"title":"海"}' }, 'stop')];
  const raw = `data: ${JSON.stringify(events[0])}\n\ndata: [DONE]`;
  const chunks = [raw.slice(0, 15), raw.slice(15, 60), raw.slice(60)];
  const encoder = new TextEncoder();
  const split = (async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        }
      })
    )) as unknown as typeof fetch;
  assert.deepEqual(await new QianwenTextProvider(split).generate(MODEL, REQUEST, CONTEXT), { title: '海' });
});

test('生成：模型不存在、没有通过工具返回、输出被截断、参数不是对象时抛出可读的错误', async () => {
  const unknown = createProvider([]);
  assert.match((await rejectedWith(unknown.provider.generate('nope', REQUEST, CONTEXT))).message, /没有文本模型/);

  const plain = createProvider([stream({ choices: [{ index: 0, delta: { content: '我不能这样做' }, finish_reason: 'stop' }] })]);
  assert.match((await rejectedWith(plain.provider.generate(MODEL, REQUEST, CONTEXT))).message, /没有通过工具返回结果：我不能这样做/);

  const truncated = createProvider([stream(toolCallChunk({ name: 'submit_creative', args: '{"title":"未完' }, 'length'))]);
  assert.match((await rejectedWith(truncated.provider.generate(MODEL, REQUEST, CONTEXT))).message, /被截断/);

  const broken = createProvider([stream(toolCallChunk({ name: 'submit_creative', args: '{"title":' }, 'stop'))]);
  assert.match((await rejectedWith(broken.provider.generate(MODEL, REQUEST, CONTEXT))).message, /不是合法的 JSON/);

  const notObject = createProvider([stream(toolCallChunk({ name: 'submit_creative', args: '[1]' }, 'stop'))]);
  assert.match((await rejectedWith(notObject.provider.generate(MODEL, REQUEST, CONTEXT))).message, /不是 JSON 对象/);
});

test('错误分类：兼容接口的错误格式按错误码和状态分类，流中途的错误事件同样处理', async () => {
  const badKey = createProvider([{ status: 401, body: { error: { message: 'Invalid API-key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } } }]);
  const auth = await rejectedWith(badKey.provider.generate(MODEL, REQUEST, CONTEXT));
  assert.deepEqual([auth.category, auth.code], ['auth', 'invalid_api_key']);
  assert.match(auth.message, /Invalid API-key provided/);

  const limited = createProvider([{ status: 429, body: { error: { message: 'limit', code: 'limit_requests' } } }]);
  assert.equal((await rejectedWith(limited.provider.generate(MODEL, REQUEST, CONTEXT))).category, 'rate_limited');

  const rejected = createProvider([{ status: 400, body: { error: { message: 'inappropriate content', code: 'data_inspection_failed' } } }]);
  assert.equal((await rejectedWith(rejected.provider.generate(MODEL, REQUEST, CONTEXT))).category, 'content_rejected');

  const midStream = createProvider([stream({ error: { message: 'internal error', code: 'internal_error' } })]);
  assert.equal((await rejectedWith(midStream.provider.generate(MODEL, REQUEST, CONTEXT))).category, 'server');

  const offline = createProvider([new Error('ECONNRESET')]);
  assert.equal((await rejectedWith(offline.provider.generate(MODEL, REQUEST, CONTEXT))).category, 'network');

  const wrongEndpoint = createProvider([]);
  const badContext = { ...CONTEXT, settings: { endpoint: 'https://api.test/compatible-mode/v1' } };
  assert.equal((await rejectedWith(wrongEndpoint.provider.generate(MODEL, REQUEST, badContext))).category, 'invalid_request');
});
