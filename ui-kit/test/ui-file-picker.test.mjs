// ------------------------------------------------------------------------
// 名称：ui-file-picker.test.mjs
// 说明：文件选择控件的 DOM 测试：选择与读取、类型数量大小限制、单选替换、排序与移除、禁用，以及样式只用令牌。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用 jsdom；通过给隐藏的文件输入设置 files 并派发 change 事件模拟用户选择。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { sourceRoot } from './load-manifest.mjs';
import { createUiEnvironment, fire } from './ui-environment.mjs';

let env;

/** 每个用例使用全新的页面，结束后释放。 */
function setup() {
  env = createUiEnvironment();
  return env.aiUi;
}

afterEach(() => env?.close());

/** 构造一个文件对象。 */
function makeFile(name, content = 'hello', type = '') {
  return new env.window.File([content], name, { type });
}

/** 模拟用户在文件选择框中选中文件。 */
function choose(control, files) {
  const input = control.element.querySelector('input[type="file"]');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fire(env, input, 'change');
}

/** jsdom 内创建的对象来自另一个运行环境，转成普通对象后才能用严格相等比较。 */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 取列表中各文件的名称。 */
function names(control) {
  return [...control.element.querySelectorAll('.ui-file-picker__name')].map((element) => element.textContent);
}

/** 找到某个文件行里的按钮。 */
function rowButton(control, fileName, text) {
  const row = [...control.element.querySelectorAll('.ui-file-picker__item')].find((item) => item.textContent.includes(fileName));
  return [...row.querySelectorAll('button')].find((button) => button.textContent === text);
}

test('选择文件：读取为 Base64，返回名称、类型、大小和内容，完成后触发变化通知', async () => {
  const ui = setup();
  const changes = [];
  const control = ui.filePicker({ accept: ['.txt'], onChange: (files) => changes.push(files.length) });

  choose(control, [makeFile('novel.txt', 'hello', 'text/plain')]);
  await control.whenReady();

  assert.deepEqual(plain(control.getValue()), [
    { name: 'novel.txt', mimeType: 'text/plain', size: 5, data: Buffer.from('hello').toString('base64') }
  ]);
  assert.deepEqual(changes, [1]);
  assert.deepEqual(names(control), ['novel.txt']);
});

test('没有类型信息的文件按扩展名推断，中文内容按字节读取', async () => {
  const ui = setup();
  const control = ui.filePicker({ accept: ['.md'] });

  choose(control, [makeFile('灯塔.md', '第一章')]);
  await control.whenReady();

  const [file] = control.getValue();
  assert.equal(file.mimeType, 'text/markdown');
  assert.equal(Buffer.from(file.data, 'base64').toString('utf8'), '第一章');
});

test('限制：类型不符、空文件和过大的文件不加入，原因显示在控件下方', async () => {
  const ui = setup();
  const control = ui.filePicker({ accept: ['.txt'], maxFileBytes: 10 });

  choose(control, [makeFile('a.pdf'), makeFile('empty.txt', ''), makeFile('big.txt', 'x'.repeat(11))]);
  await control.whenReady();

  assert.deepEqual(plain(control.getValue()), []);
  const message = control.element.querySelector('.ui-file-picker__message');
  assert.equal(message.hidden, false);
  assert.ok(message.classList.contains('ui-is-error'));
  assert.match(message.textContent, /a\.pdf.*类型不受支持/);
  assert.match(message.textContent, /empty\.txt.*空文件/);
  assert.match(message.textContent, /big\.txt.*超过大小上限/);
});

test('多选：按顺序追加，超过数量上限或重复的文件不加入', async () => {
  const ui = setup();
  const control = ui.filePicker({ accept: ['.png'], multiple: true, maxFiles: 2 });

  choose(control, [makeFile('a.png', 'a'), makeFile('b.png', 'b'), makeFile('c.png', 'c')]);
  await control.whenReady();
  assert.deepEqual(names(control), ['a.png', 'b.png']);
  assert.match(control.element.querySelector('.ui-file-picker__message').textContent, /最多选择 2 个文件/);

  choose(control, [makeFile('a.png', 'a')]);
  await control.whenReady();
  assert.deepEqual(names(control), ['a.png', 'b.png']);
});

test('单选：再次选择会替换原来的文件', async () => {
  const ui = setup();
  const control = ui.filePicker({ accept: ['.txt'] });

  choose(control, [makeFile('one.txt', '1')]);
  await control.whenReady();
  choose(control, [makeFile('two.txt', '2')]);
  await control.whenReady();

  assert.deepEqual(names(control), ['two.txt']);
  assert.equal(control.element.querySelector('input').multiple, false);
  assert.equal(rowButton(control, 'two.txt', '上移'), undefined, '单选没有排序按钮');
});

test('排序与移除：上移、下移改变顺序，边界按钮禁用，移除后触发变化通知', async () => {
  const ui = setup();
  const changes = [];
  const control = ui.filePicker({ accept: ['.png'], multiple: true, onChange: () => changes.push(names(control).join(',')) });
  choose(control, [makeFile('a.png', 'a'), makeFile('b.png', 'b'), makeFile('c.png', 'c')]);
  await control.whenReady();

  assert.equal(rowButton(control, 'a.png', '上移').disabled, true);
  assert.equal(rowButton(control, 'c.png', '下移').disabled, true);
  rowButton(control, 'c.png', '上移').click();
  assert.deepEqual(plain(control.getValue().map((file) => file.name)), ['a.png', 'c.png', 'b.png']);
  rowButton(control, 'a.png', '下移').click();
  assert.deepEqual(names(control), ['c.png', 'a.png', 'b.png']);
  rowButton(control, 'a.png', '移除').click();
  assert.deepEqual(names(control), ['c.png', 'b.png']);
  assert.equal(changes.at(-1), 'c.png,b.png');
});

test('可访问性：按钮带含文件名的可访问名称，状态说明区是 live 区域', async () => {
  const ui = setup();
  const control = ui.filePicker({ multiple: true, ariaLabel: '灵感图片' });
  choose(control, [makeFile('a.png', 'a')]);
  await control.whenReady();

  assert.equal(control.element.getAttribute('role'), 'group');
  assert.equal(control.element.getAttribute('aria-label'), '灵感图片');
  assert.equal(rowButton(control, 'a.png', '移除').getAttribute('aria-label'), '移除：a.png');
  assert.equal(control.element.querySelector('.ui-file-picker__message').getAttribute('aria-live'), 'polite');
});

test('禁用：选择按钮与行内按钮都不可用，恢复后可用', async () => {
  const ui = setup();
  const control = ui.filePicker({ multiple: true });
  choose(control, [makeFile('a.png', 'a')]);
  await control.whenReady();

  control.setDisabled(true);
  assert.equal(control.element.querySelector('.ui-button').disabled, true);
  assert.equal(rowButton(control, 'a.png', '移除').disabled, true);
  control.setDisabled(false);
  assert.equal(rowButton(control, 'a.png', '移除').disabled, false);
});

test('setValue 直接设置文件列表，不触发变化通知', () => {
  const ui = setup();
  const changes = [];
  const control = ui.filePicker({ onChange: () => changes.push(1) });
  control.setValue([{ name: 'a.txt', mimeType: 'text/plain', size: 1, data: 'YQ==' }]);
  assert.deepEqual(names(control), ['a.txt']);
  assert.deepEqual(changes, []);
});

test('样式：文件选择控件只使用令牌颜色', () => {
  const css = readFileSync(join(sourceRoot, 'ui-file-picker.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\(/i);
  for (const name of new Set(css.match(/--[a-z-]+/g))) {
    assert.ok(readFileSync(join(sourceRoot, 'ui-tokens.css'), 'utf8').includes(`${name}:`), `缺少令牌 ${name}`);
  }
});
