// ------------------------------------------------------------------------
// 名称：sidebar.js
// 说明：侧栏页面脚本：菜单按钮的按下视觉状态，以及把点击交给扩展宿主。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求名称与 src/sidebar/sidebar-handlers.ts 一致；依赖 shared/host-bridge.js 与界面组件库。
// ------------------------------------------------------------------------

'use strict';

const PRESSED_CLASS = 'is-pressed';
const REQUEST_OPEN = 'sidebar.open';
const NOTICE_TITLE = '提示';
const UNAVAILABLE_MESSAGE = '该功能尚未开放。';
const GENERIC_ERROR_MESSAGE = '操作失败，请重试。';

/**
 * 通知宿主某一菜单行的按钮被点击；宿主未处理（功能尚未开放）时用页内对话框提示。
 * @param {HTMLElement} row 按钮所在的菜单行。
 * @param {'main' | 'action'} target 点击的位置：主入口或尾部操作。
 */
async function notifyClick(row, target) {
  try {
    const result = await window.hostBridge.request(REQUEST_OPEN, { itemId: row.dataset.itemId, target });
    if (!result.handled) await aiUi.alert({ title: NOTICE_TITLE, message: UNAVAILABLE_MESSAGE });
  } catch (error) {
    await aiUi.alert({ title: NOTICE_TITLE, message: (error && error.message) || GENERIC_ERROR_MESSAGE });
  }
}

/**
 * 为按钮绑定按下状态：按下时捕获指针，在松开、取消或丢失捕获时清除。
 * @param {HTMLButtonElement} button 需要绑定的按钮。
 * @param {HTMLElement} row 按钮所在的菜单行。
 * @param {boolean} shouldPressRow 按下时是否同时高亮整行。
 */
function bindPressedState(button, row, shouldPressRow) {
  const clearPressed = () => {
    if (shouldPressRow) row.classList.remove(PRESSED_CLASS);
    button.classList.remove(PRESSED_CLASS);
  };
  button.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (shouldPressRow) row.classList.add(PRESSED_CLASS);
    button.classList.add(PRESSED_CLASS);
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener('pointerup', clearPressed);
  button.addEventListener('pointercancel', clearPressed);
  button.addEventListener('lostpointercapture', clearPressed);
}

for (const row of document.querySelectorAll('.menu-row')) {
  const mainButton = row.querySelector('.menu-main');
  const actionButton = row.querySelector('.menu-action');
  if (mainButton) {
    bindPressedState(mainButton, row, true);
    mainButton.addEventListener('click', () => notifyClick(row, 'main'));
  }
  if (actionButton) {
    bindPressedState(actionButton, row, false);
    actionButton.addEventListener('click', () => notifyClick(row, 'action'));
  }
}
