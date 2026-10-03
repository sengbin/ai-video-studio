// ------------------------------------------------------------------------
// 名称：token-estimate.test.ts
// 说明：token 数估算的自动化测试：中日韩文字、其他字符与混合文本。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：纯函数测试。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { estimateTokens } from './token-estimate';

test('中文每字约 1 个 token，其他字符每 3 个字符约 1 个 token（向上取整）', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('你好，世界'), 5);
  assert.equal(estimateTokens('hello'), 2);
  assert.equal(estimateTokens('你好 hello'), 2 + 2);
});

test('估算随文本长度单调增加', () => {
  assert.ok(estimateTokens('中'.repeat(1000)) > estimateTokens('中'.repeat(10)));
});
