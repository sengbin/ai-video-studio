// ------------------------------------------------------------------------
// 名称：ui-controls.test.mjs
// 说明：界面组件库控件的 DOM 测试：按钮、文本、下拉、单选、复选、开关、字段，含可用与禁用两种状态。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用 jsdom；无排版，只验证行为、属性和类名，不验证视觉。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createUiEnvironment, drag, fire, pressKey, typeText } from './ui-environment.mjs';

let env;

/** 每个用例使用全新的页面，结束后释放。 */
function setup() {
  env = createUiEnvironment();
  return { ui: env.aiUi, doc: env.document };
}

afterEach(() => env?.close());

/** 每种控件的创建函数，供“可用与禁用状态”的统一用例使用。 */
function controlFactories(ui) {
  const options = ['甲', '乙'];
  return [
    ['单行输入', (disabled) => ui.textInput({ disabled })],
    ['多行文本', (disabled) => ui.textArea({ disabled })],
    ['下拉列表', (disabled) => ui.select({ options, disabled })],
    ['带手动输入的下拉列表', (disabled) => ui.select({ options, allowCustom: true, disabled })],
    ['单选组', (disabled) => ui.radioGroup({ options, disabled })],
    ['复选框', (disabled) => ui.checkbox({ label: '选项', disabled })],
    ['复选框组', (disabled) => ui.checkboxGroup({ options, disabled })],
    ['开关', (disabled) => ui.switchControl({ label: '开关', disabled })],
    ['文件选择', (disabled) => ui.filePicker({ disabled })]
  ];
}

test('所有控件都能以禁用状态创建，也能在可用与禁用之间切换', () => {
  const { ui } = setup();
  for (const [name, create] of controlFactories(ui)) {
    const disabledControl = create(true);
    assert.equal(disabledControl.isDisabled(), true, `${name}：创建时禁用`);
    assert.ok(disabledControl.element.classList.contains('ui-is-disabled'), `${name}：禁用时根元素应带 ui-is-disabled`);

    const enabledControl = create(false);
    assert.equal(enabledControl.isDisabled(), false, `${name}：创建时可用`);
    assert.ok(!enabledControl.element.classList.contains('ui-is-disabled'), `${name}：可用时不应带 ui-is-disabled`);

    enabledControl.setDisabled(true);
    assert.equal(enabledControl.isDisabled(), true, `${name}：切换为禁用`);
    assert.ok(enabledControl.element.classList.contains('ui-is-disabled'), `${name}：切换后应带 ui-is-disabled`);
    enabledControl.setDisabled(false);
    assert.ok(!enabledControl.element.classList.contains('ui-is-disabled'), `${name}：恢复后应去掉 ui-is-disabled`);
  }
});

test('按钮预设：添加、修改、删除带有默认文字、样式和图标', () => {
  const { ui } = setup();
  const cases = [
    ['add', '添加', 'ui-button--primary'],
    ['edit', '修改', 'ui-button--secondary'],
    ['delete', '删除', 'ui-button--danger']
  ];
  for (const [kind, text, variantClass] of cases) {
    const button = ui.button({ kind });
    assert.equal(button.element.textContent, text);
    assert.ok(button.element.classList.contains(variantClass), `${kind} 应使用 ${variantClass}`);
    assert.ok(button.element.classList.contains(`ui-button--${kind}`));
    assert.ok(button.element.querySelector('svg.ui-button__icon'), `${kind} 应带图标`);
  }
});

test('按钮：可覆盖预设的文字与样式，可去掉图标，未知预设报错', () => {
  const { ui } = setup();
  const custom = ui.button({ kind: 'add', text: '创建项目', variant: 'secondary', icon: false });
  assert.equal(custom.element.textContent, '创建项目');
  assert.ok(custom.element.classList.contains('ui-button--secondary'));
  assert.equal(custom.element.querySelector('svg'), null);
  assert.throws(() => ui.button({ kind: 'unknown' }), /未知的按钮预设/);
});

test('按钮：纯图标模式没有文字，文字作为可访问名称', () => {
  const { ui } = setup();
  const button = ui.button({ kind: 'delete', iconOnly: true });
  assert.equal(button.element.textContent, '');
  assert.equal(button.element.getAttribute('aria-label'), '删除');
  assert.ok(button.element.classList.contains('ui-button--icon-only'));
  button.setText('移除');
  assert.equal(button.element.getAttribute('aria-label'), '移除');
});

test('按钮：可用时触发点击，禁用后不触发，恢复后再次触发', () => {
  const { ui, doc } = setup();
  let clicks = 0;
  const button = ui.button({ text: '保存', variant: 'primary', onClick: () => (clicks += 1) });
  doc.body.append(button.element);

  button.element.click();
  assert.equal(clicks, 1);
  button.setDisabled(true);
  assert.equal(button.isDisabled(), true);
  button.element.click();
  assert.equal(clicks, 1);
  button.setDisabled(false);
  button.element.click();
  assert.equal(clicks, 2);
});

test('按钮：以禁用状态创建时不可点击', () => {
  const { ui } = setup();
  let clicks = 0;
  for (const kind of ['add', 'edit', 'delete']) {
    const button = ui.button({ kind, disabled: true, onClick: () => (clicks += 1) });
    button.element.click();
    assert.equal(button.element.disabled, true);
  }
  assert.equal(clicks, 0);
});

test('单行输入与多行文本：读写值、变化通知、校验标记', () => {
  const { ui } = setup();
  for (const create of [ui.textInput, ui.textArea]) {
    const seen = [];
    const control = create({ value: '初始', onChange: (value) => seen.push(value) });
    assert.equal(control.getValue(), '初始');
    control.setValue('新值');
    assert.equal(control.getValue(), '新值');
    assert.deepEqual(seen, [], '程序设置值不应触发变化通知');

    typeText(env, control.focusTarget, '用户输入');
    assert.deepEqual(seen, ['用户输入']);

    control.setInvalid(true);
    assert.equal(control.focusTarget.getAttribute('aria-invalid'), 'true');
    control.setInvalid(false);
    assert.equal(control.focusTarget.hasAttribute('aria-invalid'), false);
  }
});

test('单行输入与多行文本：禁用时原生控件被禁用', () => {
  const { ui } = setup();
  for (const create of [ui.textInput, ui.textArea]) {
    const control = create({ disabled: true });
    assert.equal(control.focusTarget.disabled, true);
    control.setDisabled(false);
    assert.equal(control.focusTarget.disabled, false);
  }
});

test('单行输入：回车触发 onEnter', () => {
  const { ui } = setup();
  let entered = 0;
  const control = ui.textInput({ onEnter: () => (entered += 1) });
  pressKey(env, control.focusTarget, 'Enter');
  pressKey(env, control.focusTarget, 'a');
  assert.equal(entered, 1);
});

test('多行文本：拖动右下角自绘把手调整高度，禁用时不可调整', () => {
  const { ui, doc } = setup();
  const control = ui.textArea({ rows: 3 });
  doc.body.append(control.element);
  const grip = control.element.querySelector('.ui-textarea__grip');
  const field = control.focusTarget;
  assert.ok(grip, '应有自绘把手');
  assert.equal(grip.getAttribute('aria-hidden'), 'true');

  drag(env, grip, 0, 40);
  assert.equal(field.style.height, '140px', '按住把手向下拖 40，高度在原基础上增加 40');
  drag(env, grip, 0, -30);
  assert.equal(field.style.height, '110px');

  control.setDisabled(true);
  drag(env, grip, 0, 50);
  assert.equal(field.style.height, '110px', '禁用后不响应');
});

test('下拉列表：点击展开、选择选项并通知变化', () => {
  const { ui, doc } = setup();
  const seen = [];
  const control = ui.select({ options: [{ value: 'a', label: '甲' }, '乙'], onChange: (value) => seen.push(value) });
  doc.body.append(control.element);

  control.focusTarget.click();
  assert.equal(control.focusTarget.getAttribute('aria-expanded'), 'true');
  const options = doc.querySelectorAll('.ui-select__option');
  assert.equal(options.length, 3, '含“请选择”空项');

  options[1].click();
  assert.equal(control.getValue(), 'a');
  assert.equal(control.focusTarget.textContent, '甲');
  assert.deepEqual(seen, ['a']);
  assert.equal(doc.querySelector('.ui-select__popup'), null, '选择后弹层关闭');
});

test('下拉列表：键盘上下选择、回车确认、Esc 只关闭弹层', () => {
  const { ui, doc } = setup();
  const control = ui.select({ options: ['甲', '乙', '丙'], allowEmpty: false });
  doc.body.append(control.element);

  pressKey(env, control.focusTarget, 'ArrowDown');
  assert.ok(doc.querySelector('.ui-select__popup'), '方向键展开弹层');
  pressKey(env, control.focusTarget, 'ArrowDown');
  pressKey(env, control.focusTarget, 'Enter');
  assert.equal(control.getValue(), '乙');

  pressKey(env, control.focusTarget, 'Enter');
  pressKey(env, control.focusTarget, 'Escape');
  assert.equal(doc.querySelector('.ui-select__popup'), null);
  assert.equal(control.getValue(), '乙', 'Esc 不改变已选值');
});

test('下拉列表：允许手动输入时，选“其他”后取输入框中的文本', () => {
  const { ui, doc } = setup();
  const control = ui.select({ options: ['甲'], allowCustom: true });
  doc.body.append(control.element);
  const customInput = control.element.querySelector('.ui-select__custom');
  assert.equal(customInput.hidden, true);

  control.focusTarget.click();
  const options = doc.querySelectorAll('.ui-select__option');
  options[options.length - 1].click();
  assert.equal(customInput.hidden, false);
  typeText(env, customInput.querySelector('input'), '自定义风格');
  assert.equal(control.getValue(), '自定义风格');

  control.setValue('甲');
  assert.equal(customInput.hidden, true);
  control.setValue('不在列表中');
  assert.equal(customInput.hidden, false, '不在列表中的值回显到手动输入框');
  assert.equal(control.getValue(), '不在列表中');
});

test('下拉列表：禁用时不能展开，展开中禁用会关闭弹层', () => {
  const { ui, doc } = setup();
  const control = ui.select({ options: ['甲'], disabled: true, allowCustom: true });
  doc.body.append(control.element);
  assert.equal(control.focusTarget.disabled, true);
  assert.equal(control.element.querySelector('.ui-select__custom').classList.contains('ui-is-disabled'), true);
  control.focusTarget.click();
  assert.equal(doc.querySelector('.ui-select__popup'), null);

  control.setDisabled(false);
  control.focusTarget.click();
  assert.ok(doc.querySelector('.ui-select__popup'));
  control.setDisabled(true);
  assert.equal(doc.querySelector('.ui-select__popup'), null);
});

test('单选组：点击与方向键选择，只有一项被选中', () => {
  const { ui, doc } = setup();
  const seen = [];
  const control = ui.radioGroup({ options: ['甲', '乙', '丙'], value: '甲', onChange: (value) => seen.push(value) });
  doc.body.append(control.element);
  const radios = control.element.querySelectorAll('[role="radio"]');

  radios[2].click();
  assert.equal(control.getValue(), '丙');
  pressKey(env, radios[2], 'ArrowRight');
  assert.equal(control.getValue(), '甲', '方向键循环到第一项');
  assert.deepEqual(seen, ['丙', '甲']);
  assert.equal(control.element.querySelectorAll('[aria-checked="true"]').length, 1);
});

test('单选组：禁用时点击和按键都不改变选择', () => {
  const { ui, doc } = setup();
  const control = ui.radioGroup({ options: ['甲', '乙'], value: '甲', disabled: true });
  doc.body.append(control.element);
  const radios = control.element.querySelectorAll('[role="radio"]');
  radios[1].click();
  pressKey(env, radios[0], 'ArrowDown');
  assert.equal(control.getValue(), '甲');
  for (const radio of radios) {
    assert.equal(radio.getAttribute('aria-disabled'), 'true');
    assert.equal(radio.tabIndex, -1);
  }

  control.setDisabled(false);
  radios[1].click();
  assert.equal(control.getValue(), '乙');
});

test('复选框：点击和空格切换，禁用时不切换', () => {
  const { ui, doc } = setup();
  const seen = [];
  const control = ui.checkbox({ label: '同意', onChange: (checked) => seen.push(checked) });
  doc.body.append(control.element);

  control.element.click();
  assert.equal(control.getValue(), true);
  pressKey(env, control.element, ' ');
  assert.equal(control.getValue(), false);
  assert.deepEqual(seen, [true, false]);

  control.setDisabled(true);
  control.element.click();
  pressKey(env, control.element, ' ');
  assert.equal(control.getValue(), false);
  assert.equal(control.element.getAttribute('aria-disabled'), 'true');
});

test('复选框组：多选按选项顺序返回，禁用时不切换', () => {
  const { ui, doc } = setup();
  const control = ui.checkboxGroup({ options: ['甲', '乙', '丙'], value: ['丙'] });
  doc.body.append(control.element);
  const boxes = control.element.querySelectorAll('[role="checkbox"]');

  boxes[0].click();
  assert.deepEqual(control.getValue(), ['甲', '丙']);
  boxes[2].click();
  assert.deepEqual(control.getValue(), ['甲']);

  control.setDisabled(true);
  boxes[1].click();
  assert.deepEqual(control.getValue(), ['甲']);
  control.setDisabled(false);
  boxes[1].click();
  assert.deepEqual(control.getValue(), ['甲', '乙']);
});

test('开关：点击开关或文字切换，禁用时都不切换', () => {
  const { ui, doc } = setup();
  const control = ui.switchControl({ label: '启用' });
  doc.body.append(control.element);
  const track = control.focusTarget;
  const label = control.element.querySelector('.ui-switch-row__label');

  track.click();
  assert.equal(control.getValue(), true);
  assert.equal(track.getAttribute('aria-checked'), 'true');
  label.click();
  assert.equal(control.getValue(), false);

  control.setDisabled(true);
  assert.equal(track.disabled, true);
  track.click();
  label.click();
  assert.equal(control.getValue(), false);
});

test('字段：标签关联控件、必填说明、错误提示与无障碍属性', () => {
  const { ui, doc } = setup();
  const control = ui.textInput();
  const field = ui.field({ label: '名称', description: '不超过 20 字', required: true, control });
  doc.body.append(field.element);

  const label = field.element.querySelector('label');
  assert.equal(label.htmlFor, control.focusTarget.id);
  assert.match(field.element.querySelector('.ui-field__description')?.textContent ?? '', /^必填，不超过 20 字$/);

  field.setError('名称不能为空');
  assert.equal(field.getError(), '名称不能为空');
  assert.equal(control.focusTarget.getAttribute('aria-invalid'), 'true');
  assert.ok(control.focusTarget.getAttribute('aria-describedby'));
  field.setError('');
  assert.equal(control.focusTarget.hasAttribute('aria-invalid'), false);
});

test('字段：不可关联 label 的控件（单选组）使用 aria-labelledby', () => {
  const { ui } = setup();
  const control = ui.radioGroup({ options: ['甲', '乙'] });
  const field = ui.field({ label: '类型', control });
  assert.equal(field.element.querySelector('label'), null);
  assert.ok(control.ariaTarget.getAttribute('aria-labelledby'));
});

test('滚动条悬停标记：鼠标所在元素及祖先带 data-ui-hover，移走或离开页面后去掉', () => {
  const { doc } = setup();
  const outer = doc.createElement('div');
  const inner = doc.createElement('div');
  const other = doc.createElement('div');
  outer.append(inner);
  doc.body.append(outer, other);

  fire(env, inner, 'mouseover');
  for (const element of [inner, outer, doc.body, doc.documentElement]) {
    assert.ok(element.hasAttribute('data-ui-hover'), '悬停元素及其祖先都应被标记');
  }
  assert.equal(other.hasAttribute('data-ui-hover'), false);

  fire(env, other, 'mouseover');
  assert.equal(inner.hasAttribute('data-ui-hover'), false);
  assert.equal(outer.hasAttribute('data-ui-hover'), false);
  assert.ok(other.hasAttribute('data-ui-hover'));

  doc.documentElement.dispatchEvent(new env.window.MouseEvent('mouseleave'));
  assert.equal(doc.querySelectorAll('[data-ui-hover]').length, 0);
});
