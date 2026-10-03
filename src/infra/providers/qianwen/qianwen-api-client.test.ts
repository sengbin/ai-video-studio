// ------------------------------------------------------------------------
// 名称：qianwen-api-client.test.ts
// 说明：千问AI平台 HTTP 客户端的自动化测试：普通请求的默认超时、流式生成的空闲超时、与调用方取消信号合并、网络错误消息的脱敏与不暴露原始异常。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：用响应取消信号的假 fetch 模拟真实 fetch 的中止行为，超时配置注入很小的值；不访问网络。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../../domain/errors';
import { ProviderCallContext } from '../../../domain/ports/provider-adapters';
import { DEFAULT_QIANWEN_TIMEOUTS, QianwenApiClient, QianwenTimeouts } from './qianwen-api-client';

const CONTEXT: ProviderCallContext = { apiKey: 'sk-secret-key-123456', settings: { endpoint: 'https://api.test/api/v1' } };
const FAST_TIMEOUTS: QianwenTimeouts = { requestMs: 30, streamIdleMs: 60 };

/** 保活定时器的时长，需大于任何测试的超时。 */
const KEEP_ALIVE_MS = 10_000;

/** 等待指定毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 一直不响应、只在信号中止时以信号的原因拒绝的 fetch，与真实 fetch 的中止行为一致。 */
function hangingFetch(): { fetchFunction: typeof fetch; signals: Array<AbortSignal | null | undefined> } {
  const signals: Array<AbortSignal | null | undefined> = [];
  const fetchFunction = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      signals.push(init?.signal);
      if (init?.signal?.aborted === true) {
        reject(init.signal.reason);
        return;
      }
      // AbortSignal.timeout 的计时器不会让事件循环保持运行，这里用一个定时器保活，直到信号中止。
      const keepAlive = setTimeout(() => undefined, KEEP_ALIVE_MS);
      init?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        },
        { once: true }
      );
    })) as typeof fetch;
  return { fetchFunction, signals };
}

/** 返回流式响应的 fetch：intervalMs 间隔产出 lines 里的每一行，产完不关闭（interval 为 null 时一行都不产出）；信号中止时流以原因出错。 */
function streamingFetch(lines: string[], intervalMs: number | null, closeAfter = false): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), { once: true });
        },
        async pull(controller) {
          if (intervalMs === null) {
            await new Promise(() => undefined);
          }
          if (index >= lines.length) {
            if (closeAfter) {
              controller.close();
              return;
            }
            await new Promise(() => undefined);
          }
          await sleep(intervalMs ?? 0);
          controller.enqueue(new TextEncoder().encode(`${lines[index]}\n\n`));
          index += 1;
        }
      },
      { highWaterMark: 0 }
    );
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
}

/** 收集流式请求产出的全部事件。 */
async function collect(stream: AsyncGenerator<string>): Promise<string[]> {
  const events: string[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

test('默认超时：普通请求带超时信号，超时常量符合预期量级', async () => {
  const { fetchFunction, signals } = hangingFetch();
  const client = new QianwenApiClient(fetchFunction, FAST_TIMEOUTS);
  await assert.rejects(client.postJson(CONTEXT, '/x', {}));
  assert.ok(signals[0] instanceof AbortSignal);
  assert.ok(DEFAULT_QIANWEN_TIMEOUTS.requestMs >= 30_000, '普通请求默认超时至少 30 秒');
  assert.ok(DEFAULT_QIANWEN_TIMEOUTS.streamIdleMs >= DEFAULT_QIANWEN_TIMEOUTS.requestMs, '流式空闲超时不短于普通请求');
});

test('普通请求超时：转为可重试的 network 类 ProviderError，说明请求超时，不暴露原始异常', async () => {
  const client = new QianwenApiClient(hangingFetch().fetchFunction, FAST_TIMEOUTS);
  for (const action of [() => client.postJson(CONTEXT, '/submit', { a: 1 }), () => client.getJson(CONTEXT, '/tasks/1')]) {
    await assert.rejects(action(), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.category, 'network');
      assert.equal(error.retryable, true);
      assert.match(error.message, /请求超时/);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('调用方的取消信号与超时合并：取消时原样抛出取消异常，不当作超时或网络故障', async () => {
  const controller = new AbortController();
  const client = new QianwenApiClient(hangingFetch().fetchFunction, { requestMs: 5_000, streamIdleMs: 5_000 });
  const pending = client.getJson({ ...CONTEXT, signal: controller.signal }, '/tasks/1');
  controller.abort();
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(!(error instanceof ProviderError));
    assert.equal((error as Error).name, 'AbortError');
    return true;
  });
});

test('调用方传入已中止的信号：不因超时被改写，仍是取消', async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new QianwenApiClient(hangingFetch().fetchFunction, FAST_TIMEOUTS);
  await assert.rejects(client.postJson({ ...CONTEXT, signal: controller.signal }, '/x', {}), (error: unknown) => !(error instanceof ProviderError));
});

test('调用方自带超时信号（如测试连接）先触发：按超时处理，转为 network 类 ProviderError 而不是原样抛出', async () => {
  const client = new QianwenApiClient(hangingFetch().fetchFunction, { requestMs: 5_000, streamIdleMs: 5_000 });
  await assert.rejects(client.getJson({ ...CONTEXT, signal: AbortSignal.timeout(20) }, '/tasks/1'), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.category, 'network');
    assert.match(error.message, /请求超时/);
    return true;
  });
  const streamClient = new QianwenApiClient(streamingFetch([], null), { requestMs: 5_000, streamIdleMs: 5_000 });
  await assert.rejects(collect(streamClient.postEventStream({ ...CONTEXT, signal: AbortSignal.timeout(20) }, '/chat/completions', {})), /请求超时/);
});

test('调用方的信号没有触发时，超时仍然生效', async () => {
  const controller = new AbortController();
  const client = new QianwenApiClient(hangingFetch().fetchFunction, FAST_TIMEOUTS);
  await assert.rejects(client.getJson({ ...CONTEXT, signal: controller.signal }, '/tasks/1'), /请求超时/);
});

test('网络错误：消息只含固定说明与脱敏摘要，不含地址、查询串和密钥，也不携带原始异常', async () => {
  const underlying = Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443'), { code: 'ECONNREFUSED' });
  const failure = new TypeError(
    'fetch failed https://api.test/api/v1/submit?token=abc123&x=1 Authorization: Bearer sk-secret-key-123456 host dashscope.aliyuncs.com:8443 key sk-another-secret-999',
    { cause: underlying }
  );
  const client = new QianwenApiClient((async () => {
    throw failure;
  }) as typeof fetch, FAST_TIMEOUTS);

  await assert.rejects(client.postJson(CONTEXT, '/submit', {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.category, 'network');
    assert.equal(error.cause, undefined, '原始异常不进入 cause');
    assert.match(error.message, /^无法连接千问AI平台：/);
    assert.match(error.message, /fetch failed/);
    for (const leaked of ['api.test', 'dashscope', 'aliyuncs', '10.1.2.3', 'token=', 'abc123', 'sk-secret', 'sk-another', 'Bearer', 'https://', '?']) {
      assert.ok(!error.message.includes(leaked), `消息不应包含 ${leaked}：${error.message}`);
    }
    return true;
  });
});

test('网络错误：附上底层错误码，摘要有长度上限', async () => {
  const withCode = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND host.example'), { code: 'ENOTFOUND' }) });
  const client = new QianwenApiClient((async () => {
    throw withCode;
  }) as typeof fetch, FAST_TIMEOUTS);
  await assert.rejects(client.getJson(CONTEXT, '/tasks/1'), { message: '无法连接千问AI平台：fetch failed（ENOTFOUND）' });

  const longMessage = new Error('错误'.repeat(500));
  const longClient = new QianwenApiClient((async () => {
    throw longMessage;
  }) as typeof fetch, FAST_TIMEOUTS);
  await assert.rejects(longClient.getJson(CONTEXT, '/tasks/1'), (error: unknown) => error instanceof ProviderError && error.message.length < 200);
});

test('流式：长时间没有数据时按空闲超时中止，转为可重试的 network 类错误', async () => {
  const client = new QianwenApiClient(streamingFetch([], null), FAST_TIMEOUTS);
  await assert.rejects(collect(client.postEventStream(CONTEXT, '/chat/completions', {})), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.category, 'network');
    assert.match(error.message, /请求超时/);
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('流式：连接建立后数据中途停止同样按空闲超时中止', async () => {
  const client = new QianwenApiClient(streamingFetch(['data: {"n":1}'], 5), FAST_TIMEOUTS);
  const received: string[] = [];
  await assert.rejects(
    (async () => {
      for await (const event of client.postEventStream(CONTEXT, '/chat/completions', {})) {
        received.push(event);
      }
    })(),
    /请求超时/
  );
  assert.deepEqual(received, ['{"n":1}']);
});

test('流式：只要数据持续到达，总时长超过空闲超时也不会中止', async () => {
  const lines = Array.from({ length: 8 }, (_, index) => `data: {"n":${index}}`);
  // 每 20ms 一条，共 160ms，超过 60ms 的空闲超时，但每次等待都没有超过它。
  const client = new QianwenApiClient(streamingFetch(lines, 20, true), FAST_TIMEOUTS);
  const events = await collect(client.postEventStream(CONTEXT, '/chat/completions', {}));
  assert.equal(events.length, 8);
});

test('流式：调用方处理事件花费的时间不计入空闲超时', async () => {
  const client = new QianwenApiClient(streamingFetch(['data: 1', 'data: 2'], 5, true), FAST_TIMEOUTS);
  const events: string[] = [];
  for await (const event of client.postEventStream(CONTEXT, '/chat/completions', {})) {
    events.push(event);
    await sleep(100);
  }
  assert.deepEqual(events, ['1', '2']);
});

test('流式：调用方取消时原样抛出取消异常', async () => {
  const controller = new AbortController();
  const client = new QianwenApiClient(streamingFetch([], null), { requestMs: 5_000, streamIdleMs: 5_000 });
  const pending = collect(client.postEventStream({ ...CONTEXT, signal: controller.signal }, '/chat/completions', {}));
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, (error: unknown) => !(error instanceof ProviderError) && (error as Error).name === 'AbortError');
});

test('流式：连接失败与读取中断的消息同样脱敏且不携带原始异常', async () => {
  const connectFailure = new QianwenApiClient((async () => {
    throw new TypeError('fetch failed https://api.test/x?key=1');
  }) as typeof fetch, FAST_TIMEOUTS);
  await assert.rejects(collect(connectFailure.postEventStream(CONTEXT, '/chat/completions', {})), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.cause, undefined);
    assert.ok(!error.message.includes('api.test'));
    return true;
  });

  const reset = new QianwenApiClient((async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('read ECONNRESET Bearer sk-secret-key-123456 https://api.test/x'));
      }
    });
    return new Response(stream);
  }) as typeof fetch, FAST_TIMEOUTS);
  await assert.rejects(collect(reset.postEventStream(CONTEXT, '/chat/completions', {})), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.category, 'network');
    assert.equal(error.cause, undefined);
    assert.match(error.message, /^读取千问AI平台的响应时中断：/);
    assert.ok(!/sk-secret|api\.test|Bearer/.test(error.message), error.message);
    return true;
  });
});

test('正常请求与 HTTP 错误不受超时包装影响', async () => {
  const ok = new QianwenApiClient((async () => new Response(JSON.stringify({ output: { id: 1 } }))) as typeof fetch, FAST_TIMEOUTS);
  assert.deepEqual(await ok.getJson(CONTEXT, '/tasks/1'), { output: { id: 1 } });

  const denied = new QianwenApiClient((async () => new Response(JSON.stringify({ code: 'InvalidApiKey', message: '密钥无效' }), { status: 401 })) as typeof fetch, FAST_TIMEOUTS);
  await assert.rejects(denied.getJson(CONTEXT, '/tasks/1'), (error: unknown) => error instanceof ProviderError && error.category === 'auth' && error.code === 'InvalidApiKey');
});
