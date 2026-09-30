// ------------------------------------------------------------------------
// 名称：copilot-error-mapping.test.ts
// 说明：Copilot 调用错误转换的自动化测试：授权、阻止、模型不存在、取消、限流与其他错误。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：用带 name、code 的普通错误对象模拟 vscode.LanguageModelError，不依赖 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TextGenerationError } from '../../domain/errors';
import { mapLanguageModelError } from './copilot-error-mapping';

/** 构造带 code 的错误，模拟 LanguageModelError。 */
function languageModelError(code: string, message = '出错了', cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { name: 'Error', code });
}

test('按 code 分类：未授权、被阻止、模型不存在', () => {
  assert.equal(mapLanguageModelError(languageModelError('NoPermissions')).category, 'not_authorized');
  assert.equal(mapLanguageModelError(languageModelError('Blocked')).category, 'rate_limited');
  assert.equal(mapLanguageModelError(languageModelError('NotFound')).category, 'unavailable');
});

test('取消：CancellationError 与 AbortError 都转为已取消', () => {
  assert.equal(mapLanguageModelError(Object.assign(new Error('x'), { name: 'Canceled' })).category, 'canceled');
  assert.equal(mapLanguageModelError(Object.assign(new Error('x'), { name: 'AbortError' })).category, 'canceled');
});

test('未知错误：消息或原因中含限流、配额字样时按限流处理，否则为一般失败并带上原始消息', () => {
  assert.equal(mapLanguageModelError(languageModelError('Unknown', 'Too Many Requests')).category, 'rate_limited');
  assert.equal(
    mapLanguageModelError(languageModelError('Unknown', '出错了', new Error('quota exceeded'))).category,
    'rate_limited'
  );
  const failed = mapLanguageModelError(new Error('网络中断'));
  assert.equal(failed.category, 'failed');
  assert.match(failed.message, /网络中断/);
});

test('已经是文本生成错误的原样返回，非 Error 的值也能处理', () => {
  const original = new TextGenerationError('refused', '被拒绝');
  assert.equal(mapLanguageModelError(original), original);
  assert.equal(mapLanguageModelError('字符串错误').category, 'failed');
  assert.equal(mapLanguageModelError(undefined).category, 'failed');
});

test('转换后的错误保留原始错误作为原因', () => {
  const cause = languageModelError('NoPermissions');
  assert.equal(mapLanguageModelError(cause).cause, cause);
});
