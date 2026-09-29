// ------------------------------------------------------------------------
// 名称：sidebar.js
// 说明：侧栏页面脚本，仅负责菜单按钮的按下视觉状态。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不发送任何消息，不实现业务功能。
// ------------------------------------------------------------------------

'use strict';

const PRESSED_CLASS = 'is-pressed';

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
  if (mainButton) bindPressedState(mainButton, row, true);
  if (actionButton) bindPressedState(actionButton, row, false);
}
