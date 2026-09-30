// ------------------------------------------------------------------------
// 名称：message-router.test.ts
// 说明：请求路由与错误映射的自动化测试。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：未预期的异常会写控制台，测试中临时静默。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { ResponseEnvelope } from './envelope';
import { MessageRouter } from './message-router';

/** 构造一个请求消息。 */
function request(name: string, payload?: unknown, requestId = 1): unknown {
  return { type: 'request', requestId, name, payload };
}

/** 断言响应为失败并返回其错误载荷。 */
function expectError(response: ResponseEnvelope | undefined) {
  assert.ok(response !== undefined && !response.ok, '应返回失败响应');
  return response.error;
}

test('成功的请求返回数据并带回请求编号', async () => {
  const router = new MessageRouter().register('echo', (payload) => ({ received: payload }));

  const response = await router.handle(request('echo', 'hi', 7));

  assert.deepEqual(response, { type: 'response', requestId: 7, ok: true, data: { received: 'hi' } });
});

test('支持异步处理函数', async () => {
  const router = new MessageRouter().register('later', async () => 42);
  const response = await router.handle(request('later'));
  assert.ok(response?.ok && response.data === 42);
});

test('不是合法请求的消息被忽略', async () => {
  const router = new MessageRouter();
  assert.equal(await router.handle(null), undefined);
  assert.equal(await router.handle('text'), undefined);
  assert.equal(await router.handle({ type: 'event', name: 'x' }), undefined);
  assert.equal(await router.handle({ type: 'request', name: 'x' }), undefined);
});

test('未注册的请求返回 unsupported', async () => {
  const error = expectError(await new MessageRouter().handle(request('missing')));
  assert.equal(error.kind, 'unsupported');
});

test('同名请求重复注册会报错', () => {
  const router = new MessageRouter().register('a', () => 1);
  assert.throws(() => router.register('a', () => 2));
});

test('校验错误带上字段错误', async () => {
  const router = new MessageRouter().register('fail', () => {
    throw new ValidationError({ name: '项目名称不能为空。' });
  });
  const error = expectError(await router.handle(request('fail')));
  assert.equal(error.kind, 'validation');
  assert.deepEqual(error.fieldErrors, { name: '项目名称不能为空。' });
});

test('冲突错误映射到对应字段', async () => {
  const router = new MessageRouter().register('fail', () => {
    throw new ConflictError('name', '已存在同名项目。');
  });
  const error = expectError(await router.handle(request('fail')));
  assert.equal(error.kind, 'conflict');
  assert.deepEqual(error.fieldErrors, { name: '已存在同名项目。' });
});

test('记录不存在映射为表单级错误', async () => {
  const router = new MessageRouter().register('fail', () => {
    throw new NotFoundError('项目 1 不存在。');
  });
  const error = expectError(await router.handle(request('fail')));
  assert.equal(error.kind, 'not-found');
  assert.deepEqual(error.fieldErrors, { '': '项目 1 不存在。' });
});

test('未预期的异常映射为 unexpected 并带简短说明', async () => {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const router = new MessageRouter().register('fail', () => {
      throw new Error('数据库损坏');
    });
    const error = expectError(await router.handle(request('fail')));
    assert.equal(error.kind, 'unexpected');
    assert.match(error.message, /数据库损坏/);
  } finally {
    console.error = originalConsoleError;
  }
});
