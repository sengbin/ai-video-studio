// ------------------------------------------------------------------------
// 名称：page-html.test.ts
// 说明：页面 HTML 外壳的自动化测试：CSP、资源引用、标题栏和转义。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：无
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPageHtml } from './page-html';

const OPTIONS = {
  title: '新建项目',
  description: '创建一个项目。',
  cspSource: 'https://webview.test',
  styleUris: ['https://webview.test/a.css', 'https://webview.test/b.css'],
  scriptUris: ['https://webview.test/a.js', 'https://webview.test/b.js']
};

test('脚本标签带 nonce，且与 CSP 中的 nonce 一致', () => {
  const html = createPageHtml(OPTIONS);
  const cspNonce = /script-src 'nonce-([0-9a-f]+)'/.exec(html)?.[1];
  assert.ok(cspNonce, 'CSP 中应有 nonce');
  const scriptNonces = [...html.matchAll(/<script nonce="([0-9a-f]+)"/g)].map((match) => match[1]);
  assert.equal(scriptNonces.length, 2);
  assert.ok(scriptNonces.every((nonce) => nonce === cspNonce));
});

test('不允许内联脚本和外部来源，样式只允许 Webview 来源', () => {
  const html = createPageHtml(OPTIONS);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /style-src https:\/\/webview\.test;/);
  assert.match(html, /img-src data:;/);
  assert.doesNotMatch(html, /unsafe-inline/);
});

test('按顺序引用全部样式与脚本，并有挂载点', () => {
  const html = createPageHtml(OPTIONS);
  assert.ok(html.indexOf('a.css') < html.indexOf('b.css'));
  assert.ok(html.indexOf('a.js') < html.indexOf('b.js'));
  assert.match(html, /<div id="app"><\/div>/);
});

test('标题栏在挂载点之前，标题与描述上下排列，右侧有工具栏插槽，描述中的特殊字符被转义', () => {
  const html = createPageHtml({ ...OPTIONS, description: '<b>描述</b>' });
  assert.match(html, /<h1 class="page-header__title">新建项目<\/h1>/);
  assert.match(html, /<p class="page-header__description">&lt;b&gt;描述&lt;\/b&gt;<\/p>/);
  assert.match(html, /<div id="page-toolbar" class="page-header__toolbar"><\/div>/);
  assert.ok(html.indexOf('page-header__title') < html.indexOf('page-header__description'));
  assert.ok(html.indexOf('page-toolbar') < html.indexOf('id="app"'));
});

test('标题中的特殊字符被转义', () => {
  const html = createPageHtml({ ...OPTIONS, title: '<script>alert(1)</script>' });
  assert.doesNotMatch(html, /<title><script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('每次生成的 nonce 不同', () => {
  const first = /nonce-([0-9a-f]+)/.exec(createPageHtml(OPTIONS))?.[1];
  const second = /nonce-([0-9a-f]+)/.exec(createPageHtml(OPTIONS))?.[1];
  assert.notEqual(first, second);
});
