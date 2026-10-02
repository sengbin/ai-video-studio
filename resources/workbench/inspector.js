// ------------------------------------------------------------------------
// 名称：inspector.js
// 说明：工作台右栏检查器的页签容器：页签栏（可带额外操作按钮）加各页签的面板，页签内容由调用方构建；支持方向键、Home、End 切换页签，页签文字可随状态更新。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：必须先于 workbench.js 加载；对外是 window.aiInspector.create；页签面板创建后一直保留在页面里（只切换显示），所以各面板的状态不会因为切换页签或页面刷新而丢失。
// ------------------------------------------------------------------------

'use strict';

(function () {
  /**
   * 创建检查器。
   * @param {{
   *   tabs: Array<{ id: string, label: string, build: () => { element: HTMLElement, refresh?: () => void } }>,
   *   initial?: string,
   *   actions?: Array<HTMLElement>,
   *   ariaLabel?: string
   * }} options tabs 为页签定义，build 创建面板内容；actions 放在页签栏右侧。
   * @returns {{ element: HTMLElement, show: (id: string, focus?: boolean) => void, getActive: () => string, setLabel: (id: string, label: string, isWarning?: boolean) => void, refresh: () => void }}
   */
  function create(options) {
    const prefix = aiUi.uid('wb-inspector');
    const items = options.tabs.map((tab) => {
      const controller = tab.build();
      const button = aiUi.h('button', {
        class: 'wb-inspector__tab',
        text: tab.label,
        attrs: { type: 'button', role: 'tab', id: `${prefix}-tab-${tab.id}`, 'aria-controls': `${prefix}-panel-${tab.id}` }
      });
      const panel = aiUi.h(
        'div',
        { class: 'wb-inspector__panel', attrs: { role: 'tabpanel', id: `${prefix}-panel-${tab.id}`, 'aria-labelledby': button.id, tabindex: 0 } },
        controller.element
      );
      return { id: tab.id, controller, button, panel };
    });
    let active = options.initial || items[0].id;

    function show(id, focus) {
      const target = items.find((item) => item.id === id);
      if (!target) return;
      active = id;
      for (const item of items) {
        const isActive = item.id === id;
        item.button.setAttribute('aria-selected', String(isActive));
        item.button.tabIndex = isActive ? 0 : -1;
        item.button.classList.toggle('wb-inspector__tab--active', isActive);
        item.panel.hidden = !isActive;
      }
      if (target.controller.refresh) target.controller.refresh();
      if (focus) target.button.focus();
    }

    function move(offset, from) {
      const index = items.findIndex((item) => item.id === from);
      show(items[(index + offset + items.length) % items.length].id, true);
    }

    for (const item of items) {
      item.button.addEventListener('click', () => show(item.id));
      item.button.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') move(1, item.id);
        else if (event.key === 'ArrowLeft') move(-1, item.id);
        else if (event.key === 'Home') show(items[0].id, true);
        else if (event.key === 'End') show(items[items.length - 1].id, true);
        else return;
        event.preventDefault();
      });
    }

    const tabList = aiUi.h('div', { class: 'wb-inspector__tabs', attrs: { role: 'tablist', 'aria-label': options.ariaLabel || '检查器' } }, items.map((item) => item.button));
    const element = aiUi.h(
      'aside',
      { class: 'wb-inspector' },
      aiUi.h('div', { class: 'wb-inspector__bar' }, tabList, aiUi.h('div', { class: 'wb-inspector__actions' }, options.actions || [])),
      items.map((item) => item.panel)
    );
    show(active);

    return {
      element,
      show,
      getActive: () => active,
      /** 更新页签文字；isWarning 为 true 时用警告色标出（文字里已含提示，不只靠颜色）。 */
      setLabel(id, label, isWarning) {
        const target = items.find((item) => item.id === id);
        if (!target) return;
        target.button.textContent = label;
        target.button.classList.toggle('wb-inspector__tab--warning', Boolean(isWarning));
      },
      refresh() {
        for (const item of items) if (item.controller.refresh) item.controller.refresh();
      }
    };
  }

  window.aiInspector = { create };
})();
