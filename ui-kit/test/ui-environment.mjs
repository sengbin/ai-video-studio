// ------------------------------------------------------------------------
// 名称：ui-environment.mjs
// 说明：界面组件库的 DOM 测试环境：用 jsdom 建立页面，按清单顺序加载 src 下的脚本，并提供模拟操作的辅助函数。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：jsdom 没有排版引擎，这里为位置与尺寸提供按内联样式换算的替代实现；事件用 MouseEvent 模拟指针事件。
// ------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { scripts, sourceRoot } from './load-manifest.mjs';

/** 内联样式没有给出尺寸时使用的替代尺寸。 */
const FALLBACK_SIZE = 100;

/** 读取内联样式中的像素值，缺失时返回默认值。 */
function readPixels(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/** 为 jsdom 补上排版相关的替代实现：可见性、位置、尺寸与滚动。 */
function installLayoutStubs(window) {
  window.Element.prototype.getBoundingClientRect = function () {
    const left = readPixels(this.style.left, 0);
    const top = readPixels(this.style.top, 0);
    const width = readPixels(this.style.width, FALLBACK_SIZE);
    const height = readPixels(this.style.height, FALLBACK_SIZE);
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  };
  window.Element.prototype.getClientRects = function () {
    return this.isConnected && !this.hidden ? [this.getBoundingClientRect()] : [];
  };
  window.HTMLElement.prototype.scrollIntoView = () => undefined;
}

/**
 * 创建一个加载了组件库的测试页面。
 * @returns {{ window: import('jsdom').DOMWindow, document: Document, aiUi: any, close: () => void }} 页面环境；测试结束时调用 close()。
 */
export function createUiEnvironment() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  installLayoutStubs(window);
  for (const file of scripts) window.eval(readFileSync(join(sourceRoot, file), 'utf8'));
  return { window, document: window.document, aiUi: window.aiUi, close: () => window.close() };
}

/** 派发一个冒泡的鼠标或指针类事件。 */
export function fire(env, target, type, init = {}) {
  target.dispatchEvent(new env.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
}

/** 在元素上按下一个按键。 */
export function pressKey(env, target, key, init = {}) {
  target.dispatchEvent(new env.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init }));
}

/** 给输入框设置文本并触发 input 事件。 */
export function typeText(env, input, text) {
  input.value = text;
  input.dispatchEvent(new env.window.Event('input', { bubbles: true }));
}

/** 按“按下、移动、松开”模拟一次拖动，事件都派发在 target 上（真实页面由指针捕获保证）。 */
export function drag(env, target, deltaX, deltaY) {
  fire(env, target, 'pointerdown', { clientX: 200, clientY: 200 });
  fire(env, target, 'pointermove', { clientX: 200 + deltaX, clientY: 200 + deltaY });
  fire(env, target, 'pointerup', { clientX: 200 + deltaX, clientY: 200 + deltaY });
}
