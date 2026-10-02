// ------------------------------------------------------------------------
// 名称：local-result-store.test.ts
// 说明：本地结果文件存储的自动化测试：下载保存与路径规则、只接受 https、HTTP 错误、大小限制与失败后不留临时文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用临时目录和假的 fetch，不访问网络。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { LocalResultStore } from './local-result-store';

const LOCATION = { projectId: 1, workId: 2, episodeId: 3 };

/** 在临时目录中创建存储。 */
async function createStore(fetchFunction: typeof fetch) {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-video-studio-store-'));
  return { root, store: new LocalResultStore(root, fetchFunction), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('保存：按项目、作品、集、镜头和任务标识命名，内容与大小正确', async () => {
  const content = Buffer.from('fake-mp4-content');
  const { root, store, cleanup } = await createStore((async () => new Response(content, { status: 200 })) as typeof fetch);
  try {
    const saved = await store.save(LOCATION, 7, 9, 'https://oss.test/video.mp4?Expires=1');
    assert.deepEqual(saved, { filePath: 'videos/1/2/3/7-9.mp4', sizeBytes: content.length });
    assert.equal(store.resolvePath(saved.filePath), path.join(root, 'videos', '1', '2', '3', '7-9.mp4'));
    assert.deepEqual(await readFile(store.resolvePath(saved.filePath)), content);
    assert.deepEqual(await readdir(path.dirname(store.resolvePath(saved.filePath))), ['7-9.mp4'], '不留临时文件');
  } finally {
    await cleanup();
  }
});

test('只接受 https 地址，不发请求', async () => {
  let called = false;
  const { store, cleanup } = await createStore((async () => {
    called = true;
    return new Response('x');
  }) as typeof fetch);
  try {
    await assert.rejects(store.save(LOCATION, 1, 1, 'http://oss.test/video.mp4'), /https/);
    await assert.rejects(store.save(LOCATION, 1, 1, 'file:///etc/passwd'), /https/);
    assert.equal(called, false);
  } finally {
    await cleanup();
  }
});

test('下载失败：HTTP 错误抛出带状态码的错误，不留下文件', async () => {
  const { root, store, cleanup } = await createStore((async () => new Response('denied', { status: 403 })) as typeof fetch);
  try {
    await assert.rejects(store.save(LOCATION, 1, 1, 'https://oss.test/video.mp4'), /HTTP 403/);
    const files = await readdir(path.join(root, 'videos', '1', '2', '3')).catch(() => []);
    assert.deepEqual(files, []);
  } finally {
    await cleanup();
  }
});

test('下载中断时清理临时文件', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.error(new Error('连接被重置'));
    }
  });
  const { root, store, cleanup } = await createStore((async () => new Response(stream, { status: 200 })) as typeof fetch);
  try {
    await assert.rejects(store.save(LOCATION, 1, 1, 'https://oss.test/video.mp4'));
    assert.deepEqual(await readdir(path.join(root, 'videos', '1', '2', '3')), []);
  } finally {
    await cleanup();
  }
});
