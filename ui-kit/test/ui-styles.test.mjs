// ------------------------------------------------------------------------
// 名称：ui-styles.test.mjs
// 说明：界面组件库样式的静态检查：滚动条无箭头、无背景、悬停才显示滑块，禁用态样式覆盖所有控件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：jsdom 不计算样式，这里直接检查样式文本；真实外观靠浏览器手工验证。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sourceRoot } from './load-manifest.mjs';

/** 读取组件库样式文件。 */
function readStyle(name) {
  return readFileSync(join(sourceRoot, name), 'utf8').replace(/\r\n/g, '\n');
}

/** 取某个选择器对应的样式块内容（选择器需完全一致）。 */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(match, `找不到样式规则：${selector}`);
  return match[1];
}

test('滚动条：去掉两端箭头，轨道与角落没有背景', () => {
  const css = readStyle('ui-scrollbar.css');
  assert.match(ruleBody(css, '*::-webkit-scrollbar-button'), /display:\s*none/);
  assert.match(ruleBody(css, '*::-webkit-scrollbar-track,\n*::-webkit-scrollbar-corner'), /background:\s*transparent/);
  assert.match(ruleBody(css, '*::-webkit-scrollbar'), /background:\s*transparent/);
});

test('滚动条：平时滑块透明，鼠标移到区域上（带悬停标记）才出现', () => {
  const css = readStyle('ui-scrollbar.css');
  assert.match(ruleBody(css, '*::-webkit-scrollbar-thumb'), /background-color:\s*transparent/);
  assert.match(ruleBody(css, '[data-ui-hover]::-webkit-scrollbar-thumb'), /background-color:\s*var\(--scrollbar-thumb-bg\)/);
  assert.match(ruleBody(css, '[data-ui-hover]::-webkit-scrollbar-thumb:hover'), /--scrollbar-thumb-hover-bg/);
});

test('滚动条：不使用标准 scrollbar-color/scrollbar-width（会让 Chromium 忽略 -webkit-scrollbar 样式）', () => {
  for (const file of ['ui-scrollbar.css', 'ui-controls.css', 'ui-dialog.css']) {
    assert.doesNotMatch(readStyle(file), /scrollbar-(color|width)\s*:/, `${file} 不应设置标准滚动条属性`);
  }
});

test('禁用态：按钮、输入、下拉、单选复选、开关都有明确样式', () => {
  const css = readStyle('ui-controls.css');
  for (const selector of [
    '.ui-input.ui-is-disabled,\n.ui-textarea.ui-is-disabled',
    '.ui-select__trigger:disabled',
    '.ui-choice[aria-disabled="true"] .ui-choice__label',
    '.ui-switch-row.ui-is-disabled .ui-switch-row__label'
  ]) {
    assert.match(ruleBody(css, selector), /var\(--disabled-(text|bg|border)\)/, `${selector} 应使用禁用态令牌`);
  }
  assert.match(ruleBody(css, '.ui-button:disabled,\n.ui-button:disabled:hover,\n.ui-button:disabled:active'), /not-allowed/);
  assert.match(ruleBody(css, '.ui-switch:disabled,\n.ui-switch:disabled:hover,\n.ui-switch:disabled:active'), /not-allowed/);
});

test('多行文本：关闭浏览器原生的拖动手柄，改用自绘把手', () => {
  const css = readStyle('ui-controls.css');
  assert.match(css, /\.ui-textarea__field \{[^}]*resize:\s*none/);
  assert.match(ruleBody(css, '.ui-textarea__grip'), /cursor:\s*ns-resize/);
  assert.match(ruleBody(css, '.ui-textarea.ui-is-disabled .ui-textarea__grip'), /display:\s*none/);
});

test('令牌：定义了禁用态颜色', () => {
  const tokens = readStyle('ui-tokens.css');
  for (const name of ['--disabled-text', '--disabled-bg', '--disabled-border']) {
    assert.ok(tokens.includes(`${name}:`), `缺少令牌 ${name}`);
  }
});
