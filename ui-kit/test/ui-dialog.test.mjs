// ------------------------------------------------------------------------
// 名称：ui-dialog.test.mjs
// 说明：界面组件库对话框的 DOM 测试：模态与非模态、确认、提示、删除确认、标题行拖动、弹出页面调整大小。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用 jsdom；位置与尺寸按内联样式换算（见 ui-environment.mjs），视口为 1024×768。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createUiEnvironment, drag, fire, pressKey, typeText } from './ui-environment.mjs';

let env;

/** 视口边距，与 ui-dialog.js 中的 VIEWPORT_MARGIN 一致。 */
const VIEWPORT_MARGIN = 8;

function setup() {
  env = createUiEnvironment();
  return { ui: env.aiUi, doc: env.document };
}

afterEach(() => env?.close());

/** 取对话框中指定文字的按钮。 */
function findButton(root, text) {
  const found = [...root.querySelectorAll('button')].find((button) => button.textContent === text);
  assert.ok(found, `找不到按钮“${text}”`);
  return found;
}

/** 让待处理的微任务（Promise 回调）执行完。 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 读取元素内联样式里的像素值。 */
function px(element, property) {
  return Number.parseFloat(element.style[property]);
}

test('对话框结构：标题、分割标题行、关闭按钮和 ARIA 属性', () => {
  const { ui, doc } = setup();
  const handle = ui.openDialog({ title: '示例', content: '内容', buttons: [{ text: '确定' }] });
  const dialog = handle.element;

  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(dialog.querySelector('.ui-dialog__title')?.textContent, '示例');
  assert.ok(dialog.querySelector('.ui-dialog__titlebar'));
  const close = dialog.querySelector('.ui-dialog__close');
  assert.equal(close?.getAttribute('aria-label'), '关闭');
  assert.ok(doc.querySelector('.ui-overlay'), '模态对话框有遮罩');
  assert.equal(dialog.querySelector('.ui-dialog__resize'), null, '普通对话框不可调整大小');
});

test('模态对话框让页面其余内容不可操作，关闭后恢复', () => {
  const { ui, doc } = setup();
  const page = doc.createElement('main');
  doc.body.append(page);

  const handle = ui.openDialog({ title: '模态', content: '内容' });
  assert.equal(page.inert, true);
  handle.close();
  assert.equal(page.inert, false);
});

test('非模态对话框没有遮罩，页面保持可操作，点击后提到最上层', () => {
  const { ui, doc } = setup();
  const page = doc.createElement('main');
  doc.body.append(page);

  const first = ui.openDialog({ title: '一', modal: false });
  const second = ui.openDialog({ title: '二', modal: false });
  assert.equal(doc.querySelector('.ui-overlay'), null);
  assert.ok(!page.inert);
  assert.ok(Number(second.element.style.zIndex) > Number(first.element.style.zIndex));

  fire(env, first.element, 'pointerdown');
  assert.ok(Number(first.element.style.zIndex) > Number(second.element.style.zIndex));
});

test('右上角关闭按钮和 Esc 关闭对话框；不可关闭的对话框忽略两者', async () => {
  const { ui, doc } = setup();
  const byButton = ui.openDialog({ title: '甲' });
  byButton.element.querySelector('.ui-dialog__close').click();
  assert.equal((await byButton.closed).reason, 'close');

  const byEscape = ui.openDialog({ title: '乙' });
  pressKey(env, byEscape.element, 'Escape');
  assert.equal((await byEscape.closed).reason, 'escape');

  const locked = ui.openDialog({ title: '丙', closable: false });
  assert.equal(locked.element.querySelector('.ui-dialog__close'), null);
  pressKey(env, locked.element, 'Escape');
  assert.ok(doc.body.contains(locked.element));
});

test('beforeClose：× 、Esc、取消按钮都先询问，返回 false 保持打开，返回其他值才关闭', async () => {
  const { ui, doc } = setup();
  const asked = [];
  let allow = false;
  const handle = ui.openDialog({
    title: '询问',
    buttons: [{ id: 'cancel', text: '取消', isCancel: true }],
    beforeClose: ({ reason }) => {
      asked.push(reason);
      return allow;
    }
  });

  handle.element.querySelector('.ui-dialog__close').click();
  await flush();
  pressKey(env, handle.element, 'Escape');
  await flush();
  findButton(handle.element, '取消').click();
  await flush();
  assert.deepEqual(asked, ['close', 'escape', 'cancel']);
  assert.ok(doc.body.contains(handle.element), '返回 false 时保持打开');

  allow = true;
  pressKey(env, handle.element, 'Escape');
  assert.equal((await handle.closed).reason, 'escape');
});

test('beforeClose：支持异步询问；询问期间重复触发不会再次询问；close() 与普通按钮不经过它', async () => {
  const { ui } = setup();
  let asks = 0;
  let release = () => undefined;
  const handle = ui.openDialog({
    title: '异步询问',
    buttons: [{ id: 'ok', text: '确定' }],
    beforeClose: () => {
      asks += 1;
      return new Promise((resolve) => (release = resolve));
    }
  });

  pressKey(env, handle.element, 'Escape');
  pressKey(env, handle.element, 'Escape');
  await flush();
  assert.equal(asks, 1, '询问未结束时不重复询问');
  release(false);
  await flush();
  assert.ok(handle.element.isConnected);

  findButton(handle.element, '确定').click();
  assert.equal((await handle.closed).reason, 'button');
  assert.equal(asks, 1, '普通按钮直接关闭');

  const other = ui.openDialog({ title: '程序关闭', beforeClose: () => false });
  other.close('api');
  assert.equal((await other.closed).reason, 'api');
});

test('beforeClose 中可以再打开确认对话框（放弃修改的典型用法）', async () => {
  const { ui, doc } = setup();
  const page = ui.openPage({
    title: '编辑',
    content: '内容',
    beforeClose: () => ui.confirm({ message: '放弃修改？', confirmText: '放弃', cancelText: '继续编辑' })
  });

  pressKey(env, page.element, 'Escape');
  await flush();
  const confirmDialog = [...doc.querySelectorAll('.ui-dialog')].find((dialog) => dialog !== page.element);
  assert.ok(confirmDialog, '应弹出确认对话框');
  findButton(confirmDialog, '继续编辑').click();
  await flush();
  assert.ok(page.element.isConnected, '选择继续编辑后页面保持打开');

  pressKey(env, page.element, 'Escape');
  await flush();
  const secondConfirm = [...doc.querySelectorAll('.ui-dialog')].find((dialog) => dialog !== page.element);
  findButton(secondConfirm, '放弃').click();
  assert.equal((await page.closed).reason, 'escape');
});

test('确认：点确定为 true，点取消或 Esc 为 false', async () => {
  const { ui, doc } = setup();

  const accepted = ui.confirm({ message: '继续吗？' });
  findButton(doc, '确定').click();
  assert.equal(await accepted, true);

  const cancelled = ui.confirm({ message: '继续吗？' });
  findButton(doc, '取消').click();
  assert.equal(await cancelled, false);

  const escaped = ui.confirm({ message: '继续吗？' });
  pressKey(env, doc.querySelector('.ui-dialog'), 'Escape');
  assert.equal(await escaped, false);
});

test('危险确认：确定按钮为危险样式，初始焦点在取消按钮', async () => {
  const { ui, doc } = setup();
  const result = ui.confirm({ message: '放弃修改？', variant: 'danger', confirmText: '放弃修改', cancelText: '继续编辑' });
  assert.ok(findButton(doc, '放弃修改').classList.contains('ui-button--danger'));
  assert.equal(doc.activeElement, findButton(doc, '继续编辑'));
  findButton(doc, '放弃修改').click();
  assert.equal(await result, true);
});

test('提示：只有一个确定按钮，回车关闭', async () => {
  const { ui, doc } = setup();
  const done = ui.alert({ message: '该功能尚未开放。' });
  assert.equal(doc.querySelectorAll('.ui-dialog__footer button').length, 1);
  pressKey(env, doc.querySelector('.ui-dialog'), 'Enter');
  await done;
  assert.equal(doc.querySelector('.ui-dialog'), null);
});

test('删除确认：名称一致（区分大小写）才能点删除', async () => {
  const { ui, doc } = setup();
  const result = ui.confirmDelete({ message: '将删除：', details: ['3 个作品'], confirmName: 'Demo', nameLabel: '项目名称' });
  const dialog = doc.querySelector('.ui-dialog');
  const deleteButton = findButton(dialog, '删除');
  const input = dialog.querySelector('input');

  assert.equal(deleteButton.disabled, true);
  assert.ok(dialog.querySelector('.ui-danger-notice'), '有红色提示');
  assert.equal(dialog.querySelector('.ui-danger-notice__name')?.textContent, 'Demo');
  assert.equal(doc.activeElement, input, '初始焦点在输入框');

  typeText(env, input, 'demo');
  assert.equal(deleteButton.disabled, true, '大小写不同不算一致');
  typeText(env, input, 'Demo');
  assert.equal(deleteButton.disabled, false);
  typeText(env, input, 'Demo ');
  assert.equal(deleteButton.disabled, true);
  typeText(env, input, 'Demo');
  deleteButton.click();
  assert.equal(await result, true);
});

test('删除确认：点取消返回 false；缺少名称时报错', async () => {
  const { ui, doc } = setup();
  const result = ui.confirmDelete({ message: '删除？', confirmName: 'A' });
  findButton(doc, '取消').click();
  assert.equal(await result, false);
  await assert.rejects(ui.confirmDelete({ message: '删除？' }), /confirmName/);
});

test('按钮的 onClick 返回 false 时对话框保持打开；处理期间按钮禁用', async () => {
  const { ui, doc } = setup();
  let release = () => undefined;
  const handle = ui.openDialog({
    title: '异步',
    buttons: [{ id: 'save', text: '保存', onClick: () => new Promise((resolve) => (release = resolve)) }]
  });
  const save = findButton(handle.element, '保存');
  save.click();
  await flush();
  assert.equal(save.disabled, true, '处理期间禁用');
  release(false);
  await flush();
  assert.equal(save.disabled, false);
  assert.ok(doc.body.contains(handle.element), '返回 false 不关闭');
});

test('拖动标题行可以移动对话框', () => {
  const { ui } = setup();
  const handle = ui.openDialog({ title: '可移动', content: '内容' });
  const dialog = handle.element;
  const titlebar = dialog.querySelector('.ui-dialog__titlebar');
  const startLeft = px(dialog, 'left');
  const startTop = px(dialog, 'top');

  drag(env, titlebar, 60, 40);
  assert.equal(px(dialog, 'left'), startLeft + 60);
  assert.equal(px(dialog, 'top'), startTop + 40);
  assert.equal(dialog.classList.contains('ui-dialog--dragging'), false, '松开后去掉拖动状态');
});

test('拖动时对话框限制在可视区域内', () => {
  const { ui } = setup();
  const handle = ui.openDialog({ title: '边界', width: 400 });
  const dialog = handle.element;
  const titlebar = dialog.querySelector('.ui-dialog__titlebar');

  drag(env, titlebar, -5000, -5000);
  assert.equal(px(dialog, 'left'), VIEWPORT_MARGIN);
  assert.equal(px(dialog, 'top'), VIEWPORT_MARGIN);

  drag(env, titlebar, 9000, 9000);
  assert.equal(px(dialog, 'left'), env.window.innerWidth - 400 - VIEWPORT_MARGIN);
  assert.equal(px(dialog, 'top'), env.window.innerHeight - 100 - VIEWPORT_MARGIN);
});

test('内容打开后才增高（表单异步渲染）时，对话框收回到可视范围内；关闭后停止监听', () => {
  const { ui } = setup();
  const observers = [];
  env.window.ResizeObserver = class {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  const handle = ui.openPage({ title: '表单', content: '加载中…', width: 400, height: 100 });
  const dialog = handle.element;
  const initialTop = px(dialog, 'top');
  assert.equal(initialTop, (env.window.innerHeight - 100) / 2, '先按加载中的小尺寸居中');

  // 内容渲染完成，高度变大：下沿超出窗口，需要向上收回。
  dialog.style.height = '700px';
  observers[0].callback();
  assert.equal(px(dialog, 'top'), env.window.innerHeight - 700 - VIEWPORT_MARGIN);

  dialog.style.height = '500px';
  observers[0].callback();
  assert.equal(px(dialog, 'top'), env.window.innerHeight - 700 - VIEWPORT_MARGIN, '高度变小时不会改变位置');

  handle.close();
  assert.equal(observers[0].disconnected, true);
});

test('弹出页面同样可以拖动标题行移动', () => {
  const { ui } = setup();
  const handle = ui.openPage({ title: '页面', content: '内容', modal: false });
  const page = handle.element;
  const startLeft = px(page, 'left');

  drag(env, page.querySelector('.ui-dialog__titlebar'), -30, 20);
  assert.equal(px(page, 'left'), startLeft - 30);
});

test('在关闭按钮上按下不会开始拖动；draggable 为 false 时标题行不可拖动', () => {
  const { ui } = setup();
  const handle = ui.openDialog({ title: '甲' });
  const dialog = handle.element;
  const startLeft = px(dialog, 'left');
  const close = dialog.querySelector('.ui-dialog__close');
  fire(env, close, 'pointerdown', { clientX: 200, clientY: 200 });
  fire(env, close, 'pointermove', { clientX: 300, clientY: 300 });
  assert.equal(px(dialog, 'left'), startLeft);
  handle.close();

  const fixed = ui.openDialog({ title: '乙', draggable: false });
  const fixedLeft = px(fixed.element, 'left');
  drag(env, fixed.element.querySelector('.ui-dialog__titlebar'), 80, 80);
  assert.equal(px(fixed.element, 'left'), fixedLeft);
});

test('弹出页面有右边、下边、右下角三个调整把手，拖动右下角同时改宽高', () => {
  const { ui } = setup();
  const handle = ui.openPage({ title: '页面', width: 600, height: 400, modal: false });
  const page = handle.element;
  for (const direction of ['e', 's', 'se']) {
    assert.ok(page.querySelector(`.ui-dialog__resize--${direction}`), `缺少 ${direction} 把手`);
  }

  drag(env, page.querySelector('.ui-dialog__resize--se'), 50, 30);
  assert.equal(px(page, 'width'), 650);
  assert.equal(px(page, 'height'), 430);
});

test('右边把手只改宽度，下边把手只改高度，且不小于最小尺寸', () => {
  const { ui } = setup();
  const handle = ui.openPage({ title: '页面', width: 600, height: 400, minWidth: 300, minHeight: 200, modal: false });
  const page = handle.element;

  drag(env, page.querySelector('.ui-dialog__resize--e'), 40, 999);
  assert.equal(px(page, 'width'), 640);
  assert.equal(px(page, 'height'), 400);

  drag(env, page.querySelector('.ui-dialog__resize--s'), 999, 30);
  assert.equal(px(page, 'width'), 640);
  assert.equal(px(page, 'height'), 430);

  drag(env, page.querySelector('.ui-dialog__resize--se'), -9000, -9000);
  assert.equal(px(page, 'width'), 300);
  assert.equal(px(page, 'height'), 200);
});

test('移动后再调整大小，仍以当前位置为基准且不超出视口', () => {
  const { ui } = setup();
  const handle = ui.openPage({ title: '页面', width: 600, height: 400, modal: false });
  const page = handle.element;
  drag(env, page.querySelector('.ui-dialog__titlebar'), 100, 50);
  const left = px(page, 'left');

  drag(env, page.querySelector('.ui-dialog__resize--e'), 9000, 0);
  assert.equal(px(page, 'width'), env.window.innerWidth - left - VIEWPORT_MARGIN);
});

test('关闭后焦点回到打开前的元素，且对话框与遮罩都被移除', () => {
  const { ui, doc } = setup();
  const opener = doc.createElement('button');
  doc.body.append(opener);
  opener.focus();

  const handle = ui.openDialog({ title: '焦点', content: '内容' });
  handle.close();
  assert.equal(doc.activeElement, opener);
  assert.equal(doc.querySelector('.ui-dialog'), null);
  assert.equal(doc.querySelector('.ui-overlay'), null);
});
