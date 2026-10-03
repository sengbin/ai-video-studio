// ------------------------------------------------------------------------
// 名称：http-media-downloader.test.ts
// 说明：HTTP 媒体下载器的自动化测试：只接受 https、HTTP 错误、Content-Length 提前拒绝、流式读取超限立即中止、读取出错时取消流。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用假的 fetch 和可观察的响应流，不访问网络。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpMediaDownloader } from './http-media-downloader';

const URL_TEXT = 'https://oss.test/file.bin';

/** 创建一个可观察的响应流：记录已产出的数据块数和是否被取消；chunks 逐块产出，之后按 endWith 结束。 */
function createObservableStream(chunks: Uint8Array[], endWith: 'close' | Error = 'close') {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulled];
      if (chunk === undefined) {
        if (endWith === 'close') {
          controller.close();
        } else {
          controller.error(endWith);
        }
        return;
      }
      state.pulled += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    }
  }, { highWaterMark: 0 });
  return { state, stream };
}

/** 构造返回固定响应的假 fetch。 */
function fakeFetch(createResponse: () => Response): typeof fetch {
  return (async () => createResponse()) as typeof fetch;
}

test('下载：合并各数据块并返回完整内容', async () => {
  const { stream } = createObservableStream([new Uint8Array([1, 2]), new Uint8Array([3])]);
  const downloader = new HttpMediaDownloader(fakeFetch(() => new Response(stream)));
  assert.deepEqual([...(await downloader.download(URL_TEXT, 10))], [1, 2, 3]);
});

test('下载：刚好等于上限允许', async () => {
  const downloader = new HttpMediaDownloader(fakeFetch(() => new Response(new Uint8Array([1, 2, 3]))));
  assert.equal((await downloader.download(URL_TEXT, 3)).length, 3);
});

test('只接受 https 地址，不发请求', async () => {
  let called = false;
  const downloader = new HttpMediaDownloader((async () => {
    called = true;
    return new Response('x');
  }) as typeof fetch);
  await assert.rejects(downloader.download('http://oss.test/a.bin', 10), /https/);
  assert.equal(called, false);
});

test('HTTP 错误：抛出带状态码的错误', async () => {
  const downloader = new HttpMediaDownloader(fakeFetch(() => new Response('denied', { status: 403 })));
  await assert.rejects(downloader.download(URL_TEXT, 10), /HTTP 403/);
});

test('Content-Length 超过上限：不读取响应体就拒绝并取消流', async () => {
  const { state, stream } = createObservableStream([new Uint8Array(4)]);
  const downloader = new HttpMediaDownloader(fakeFetch(() => new Response(stream, { headers: { 'content-length': '100' } })));
  await assert.rejects(downloader.download(URL_TEXT, 10), /超过大小上限/);
  assert.equal(state.pulled, 0, '没有读取响应体');
  assert.equal(state.cancelled, true);
});

test('没有 Content-Length：累计超过上限时立即中止，不再读取后续数据', async () => {
  const chunks = Array.from({ length: 50 }, () => new Uint8Array(4));
  const { state, stream } = createObservableStream(chunks);
  const downloader = new HttpMediaDownloader(fakeFetch(() => new Response(stream)));
  await assert.rejects(downloader.download(URL_TEXT, 10), /超过大小上限/);
  assert.equal(state.cancelled, true, '超限后取消响应流');
  assert.ok(state.pulled < chunks.length, `超限后应立即停止读取，实际读取了 ${state.pulled} 块`);
});

test('Content-Length 不实（声明很小、实际很大）：以实际读取的字节数为准', async () => {
  const { state, stream } = createObservableStream([new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)]);
  const downloader = new HttpMediaDownloader(fakeFetch(() => new Response(stream, { headers: { 'content-length': '1' } })));
  await assert.rejects(downloader.download(URL_TEXT, 10), /超过大小上限/);
  assert.equal(state.cancelled, true);
});

test('读取中途出错：抛出原错误并取消响应流', async () => {
  const { state, stream } = createObservableStream([new Uint8Array(2)], new Error('连接被重置'));
  const downloader = new HttpMediaDownloader(fakeFetch(() => new Response(stream)));
  await assert.rejects(downloader.download(URL_TEXT, 10), /连接被重置/);
  assert.equal(state.pulled, 1);
});

test('取消信号会传给 fetch', async () => {
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  const downloader = new HttpMediaDownloader((async (_url: unknown, init?: RequestInit) => {
    received = init?.signal;
    return new Response(new Uint8Array(1));
  }) as typeof fetch);
  await downloader.download(URL_TEXT, 10, controller.signal);
  assert.equal(received, controller.signal);
});
