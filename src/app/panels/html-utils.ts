// ------------------------------------------------------------------------
// 名称：html-utils.ts
// 说明：生成 Webview 页面时共用的 HTML 转义与随机数工具。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：无
// ------------------------------------------------------------------------

import { randomBytes } from 'crypto';

/** 生成用于 CSP 的随机 nonce。 */
export function createNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * 转义写入 HTML 文本和属性值的字符。
 * @param value 原始文本。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
