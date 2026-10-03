// ------------------------------------------------------------------------
// 名称：webview-messaging.test.ts
// 说明：Webview 消息连接的自动化测试：请求回复、事件推送、销毁时释放订阅并停止发送、销毁后的发送失败被忽略而其他失败被记录。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：用假的 Webview 和面板，不依赖 VS Code 环境；未预期的发送失败会写控制台，测试中临时捕获。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageRouter } from '../messaging/message-router';
import { connectWebviewMessaging } from './webview-messaging';

/** 假的 Webview 与所属面板：记录发出的消息、订阅与销毁。 */
function createFakes() {
  const sent: unknown[] = [];
  let receive: ((message: unknown) => unknown) | undefined;
  let disposeListener: (() => unknown) | undefined;
  let subscriptionDisposed = false;
  const state = { postError: undefined as Error | undefined };
  const webview = {
    onDidReceiveMessage: (listener: (message: unknown) => unknown) => {
      receive = listener;
      return { dispose: () => void (subscriptionDisposed = true) };
    },
    postMessage: async (message: unknown) => {
      if (state.postError !== undefined) {
        throw state.postError;
      }
      sent.push(message);
      return true;
    }
  };
  const owner = {
    onDidDispose: (listener: () => unknown) => {
      disposeListener = listener;
      return { dispose: () => undefined };
    }
  };
  return {
    webview,
    owner,
    sent,
    state,
    deliver: (message: unknown) => receive?.(message),
    disposeOwner: () => disposeListener?.(),
    isSubscriptionDisposed: () => subscriptionDisposed
  };
}

/** 临时捕获 console.error 的调用。 */
async function captureConsoleError(action: () => Promise<void>): Promise<unknown[][]> {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => void calls.push(args);
  try {
    await action();
  } finally {
    console.error = original;
  }
  return calls;
}

test('请求经路由器处理后回复界面', async () => {
  const fakes = createFakes();
  connectWebviewMessaging(fakes.webview, fakes.owner, new MessageRouter().register('echo', (payload) => payload));
  await fakes.deliver({ type: 'request', requestId: 1, name: 'echo', payload: 'hi' });
  assert.deepEqual(fakes.sent, [{ type: 'response', requestId: 1, ok: true, data: 'hi' }]);
});

test('没有响应的消息不回复', async () => {
  const fakes = createFakes();
  connectWebviewMessaging(fakes.webview, fakes.owner, new MessageRouter());
  await fakes.deliver({ foo: 'bar' });
  assert.deepEqual(fakes.sent, []);
});

test('postEvent 向界面推送事件', async () => {
  const fakes = createFakes();
  const messaging = connectWebviewMessaging(fakes.webview, fakes.owner, new MessageRouter());
  messaging.postEvent('assets.changed', { id: 1 });
  await Promise.resolve();
  assert.deepEqual(fakes.sent, [{ type: 'event', name: 'assets.changed', payload: { id: 1 } }]);
});

test('销毁时释放消息订阅', () => {
  const fakes = createFakes();
  connectWebviewMessaging(fakes.webview, fakes.owner, new MessageRouter());
  assert.equal(fakes.isSubscriptionDisposed(), false);
  fakes.disposeOwner();
  assert.equal(fakes.isSubscriptionDisposed(), true);
});

test('销毁后不再推送事件，也不再回复处理中的请求', async () => {
  const fakes = createFakes();
  let release: (() => void) | undefined;
  const router = new MessageRouter().register('slow', () => new Promise<string>((resolve) => (release = () => resolve('done'))));
  const messaging = connectWebviewMessaging(fakes.webview, fakes.owner, router);

  const pending = fakes.deliver({ type: 'request', requestId: 2, name: 'slow' });
  fakes.disposeOwner();
  release?.();
  await pending;
  messaging.postEvent('x');
  await Promise.resolve();

  assert.deepEqual(fakes.sent, []);
});

test('发送失败：Webview 已销毁时忽略，不写控制台', async () => {
  const fakes = createFakes();
  const messaging = connectWebviewMessaging(fakes.webview, fakes.owner, new MessageRouter());
  // 模拟“发送过程中面板被销毁”：postMessage 在销毁之后才拒绝。
  fakes.webview.postMessage = async () => {
    fakes.disposeOwner();
    throw new Error('Webview is disposed');
  };
  const logged = await captureConsoleError(async () => {
    messaging.postEvent('x');
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(logged, []);
});

test('发送失败：面板仍然存在时不吞掉，记录到控制台且不产生未处理的拒绝', async () => {
  const fakes = createFakes();
  const messaging = connectWebviewMessaging(fakes.webview, fakes.owner, new MessageRouter());
  fakes.state.postError = new Error('消息无法序列化');
  const logged = await captureConsoleError(async () => {
    messaging.postEvent('x');
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.equal(logged.length, 1);
  assert.equal((logged[0][1] as Error).message, '消息无法序列化');
});