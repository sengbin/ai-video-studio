// ------------------------------------------------------------------------
// 名称：local-asset-file-store.test.ts
// 说明：本地资产文件存储的自动化测试：按内容哈希命名与去重、读取、删除、扩展名映射、路径边界校验与不留临时文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用临时目录，不访问网络。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { LocalAssetFileStore } from './local-asset-file-store';

/** 在临时目录中创建存储。 */
function createStore() {
  const root = mkdtempSync(path.join(tmpdir(), 'aigc-video-studio-asset-files-'));
  return { root, store: new LocalAssetFileStore(root), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('保存：路径由内容哈希决定（前两位作子目录，扩展名随类型），读取得到原内容，不留临时文件', () => {
  const { root, store, cleanup } = createStore();
  try {
    const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const hash = createHash('sha256').update(content).digest('hex');
    const filePath = store.write(content, 'image/png');
    assert.equal(filePath, `${hash.slice(0, 2)}/${hash}.png`);
    assert.deepEqual(store.read(filePath), content);
    assert.deepEqual(readdirSync(path.join(root, hash.slice(0, 2))), [`${hash}.png`]);

    const extensions = [
      ['image/jpeg', '.jpg'],
      ['image/webp', '.webp'],
      ['audio/mpeg', '.mp3'],
      ['audio/wav', '.wav'],
      ['audio/mp4', '.m4a']
    ];
    for (const [mime, extension] of extensions) {
      assert.ok(store.write(Buffer.from(mime), mime).endsWith(extension), mime);
    }
    assert.throws(() => store.write(Buffer.from('x'), 'text/plain'), /不支持保存/);
  } finally {
    cleanup();
  }
});

test('相同内容只保存一份：重复保存返回同一路径', () => {
  const { root, store, cleanup } = createStore();
  try {
    const first = store.write(Buffer.from('same'), 'image/png');
    const second = store.write(Buffer.from('same'), 'image/png');
    assert.equal(first, second);
    assert.equal(readdirSync(path.join(root, first.split('/')[0])).length, 1);
    assert.notEqual(store.write(Buffer.from('other'), 'image/png'), first);
  } finally {
    cleanup();
  }
});

test('删除：文件被移除，文件不存在时什么也不做', () => {
  const { root, store, cleanup } = createStore();
  try {
    const filePath = store.write(Buffer.from('content'), 'audio/wav');
    store.remove(filePath);
    assert.equal(existsSync(path.join(root, ...filePath.split('/'))), false);
    assert.doesNotThrow(() => store.remove(filePath));
    assert.throws(() => store.read(filePath));
  } finally {
    cleanup();
  }
});

test('路径校验：读取与删除都拒绝绝对路径和越出根目录的路径', () => {
  const { store, cleanup } = createStore();
  try {
    for (const bad of ['../outside.png', 'ab/../../outside.png', '/etc/passwd', path.join(tmpdir(), 'other.png'), '']) {
      assert.throws(() => store.read(bad), /绝对路径|超出了存储目录/, bad);
      assert.throws(() => store.remove(bad), /绝对路径|超出了存储目录/, bad);
    }
  } finally {
    cleanup();
  }
});
