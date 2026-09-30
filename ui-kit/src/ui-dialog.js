// ------------------------------------------------------------------------
// 名称：ui-dialog.js
// 说明：界面组件库的对话框：模态/非模态对话框、确认、提示、删除确认和可调整大小的弹出页面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js、ui-button.js；删除确认还依赖 ui-input-controls.js；用法见 docs/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;
  const trackPointer = aiUi.trackPointer;

  const DEFAULT_DIALOG_WIDTH = 420;
  const DEFAULT_PAGE_WIDTH = 640;
  const DEFAULT_MIN_WIDTH = 320;
  const DEFAULT_MIN_HEIGHT = 160;
  const VIEWPORT_MARGIN = 8;
  const CASCADE_OFFSET = 24;
  const CASCADE_LIMIT = 5;
  const BASE_Z_INDEX = 10;
  const RESIZE_DIRECTIONS = ['e', 's', 'se'];
  const FOCUSABLE_SELECTOR =
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"]):not([aria-disabled="true"])';

  const CLOSE_LABEL = '关闭';
  const DEFAULT_CONFIRM_TITLE = '确认';
  const DEFAULT_ALERT_TITLE = '提示';
  const DEFAULT_DELETE_TITLE = '删除确认';
  const OK_TEXT = '确定';
  const CANCEL_TEXT = '取消';
  const DELETE_TEXT = '删除';

  /** 已打开的对话框记录，最后一个在最上层。 */
  const stack = [];
  /** 因模态对话框而被设为 inert 的页面元素，关闭后恢复。 */
  const inertedElements = new Set();
  let zCounter = BASE_Z_INDEX;
  let listenersInstalled = false;

  /** 数值限制在 [min, max] 之内；max 小于 min 时取 min。 */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, Math.max(min, max)));
  }

  /** 元素当前是否可见（占有布局空间）。 */
  function isVisible(element) {
    return element.getClientRects().length > 0;
  }

  /** 对话框内按 Tab 顺序可聚焦的可见元素。 */
  function listFocusable(dialog) {
    return [...dialog.querySelectorAll(FOCUSABLE_SELECTOR)].filter(isVisible);
  }

  /** 有模态对话框时，让其余页面内容失去焦点与点击；没有时恢复。 */
  function updateInert() {
    const hasModal = stack.some((record) => record.config.modal);
    const layer = aiUi.layer();
    for (const child of [...document.body.children]) {
      if (child === layer) continue;
      if (hasModal) {
        if (!child.inert) {
          child.inert = true;
          inertedElements.add(child);
        }
      } else if (inertedElements.has(child)) {
        child.inert = false;
        inertedElements.delete(child);
      }
    }
  }

  /** 把对话框提到最上层（用于非模态对话框被点击时）。 */
  function bringToFront(record) {
    zCounter += 2;
    record.dialog.style.zIndex = String(zCounter);
    if (record.overlay) record.overlay.style.zIndex = String(zCounter - 1);
    stack.splice(stack.indexOf(record), 1);
    stack.push(record);
  }

  /** 处理 Tab：焦点在最后一个元素再按 Tab 回到第一个，反之亦然。 */
  function trapFocus(record, event) {
    const focusable = listFocusable(record.dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      record.dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const isOutside = !record.dialog.contains(active);
    if (event.shiftKey && (active === first || isOutside)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || isOutside)) {
      event.preventDefault();
      first.focus();
    }
  }

  /** 全局键盘处理：Esc 关闭、Tab 焦点循环、Enter 触发默认按钮。 */
  function handleKeyDown(event) {
    const topModal = [...stack].reverse().find((record) => record.config.modal);
    const owner = topModal || stack.find((record) => record.dialog.contains(event.target));
    if (!owner) return;

    if (event.key === 'Escape' && !event.defaultPrevented && owner.config.closable) {
      event.preventDefault();
      void owner.handle.requestClose('escape');
    } else if (event.key === 'Tab' && owner.config.modal) {
      trapFocus(owner, event);
    } else if (event.key === 'Enter' && !event.defaultPrevented && owner.defaultButton) {
      const isTextField = event.target.tagName === 'INPUT' || event.target === owner.dialog;
      if (isTextField) {
        event.preventDefault();
        owner.defaultButton.element.click();
      }
    }
  }

  /** 让对话框保持在可视范围内：窗口缩小或内容增高（如表单异步渲染完成）后，超出的部分向上、向左收回。 */
  function keepInViewport(dialog) {
    const rect = dialog.getBoundingClientRect();
    dialog.style.left = `${clamp(rect.left, VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)}px`;
    dialog.style.top = `${clamp(rect.top, VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)}px`;
  }

  /** 窗口大小变化时，让对话框保持在可视范围内。 */
  function handleWindowResize() {
    for (const record of stack) keepInViewport(record.dialog);
  }

  function installListeners() {
    if (listenersInstalled) return;
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleWindowResize);
    listenersInstalled = true;
  }

  function removeListenersIfIdle() {
    if (stack.length > 0 || !listenersInstalled) return;
    document.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('resize', handleWindowResize);
    listenersInstalled = false;
  }

  /** 把对话框居中（非模态的多个对话框依次错开一点）。 */
  function placeDialog(dialog, cascadeIndex) {
    const rect = dialog.getBoundingClientRect();
    const offset = (cascadeIndex % CASCADE_LIMIT) * CASCADE_OFFSET;
    dialog.style.left = `${clamp((window.innerWidth - rect.width) / 2 + offset, VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)}px`;
    dialog.style.top = `${clamp((window.innerHeight - rect.height) / 2 + offset, VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)}px`;
  }

  /** 让对话框可以按住标题行拖动（点关闭按钮除外），移动范围限制在可视区域内。 */
  function attachDrag(dialog, titlebar) {
    titlebar.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.ui-dialog__close')) return;
      const start = dialog.getBoundingClientRect();
      dialog.classList.add('ui-dialog--dragging');
      trackPointer(
        titlebar,
        event,
        (deltaX, deltaY) => {
          dialog.style.left = `${clamp(start.left + deltaX, VIEWPORT_MARGIN, window.innerWidth - start.width - VIEWPORT_MARGIN)}px`;
          dialog.style.top = `${clamp(start.top + deltaY, VIEWPORT_MARGIN, window.innerHeight - start.height - VIEWPORT_MARGIN)}px`;
        },
        () => dialog.classList.remove('ui-dialog--dragging')
      );
    });
  }

  /** 为弹出页面添加右边、下边和右下角三个调整大小的把手。 */
  function attachResizeHandles(dialog, minWidth, minHeight) {
    for (const direction of RESIZE_DIRECTIONS) {
      const handle = aiUi.h('div', {
        class: `ui-dialog__resize ui-dialog__resize--${direction}`,
        attrs: { 'aria-hidden': 'true' }
      });
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        const start = dialog.getBoundingClientRect();
        trackPointer(handle, event, (deltaX, deltaY) => {
          if (direction.includes('e')) {
            dialog.style.width = `${clamp(start.width + deltaX, minWidth, window.innerWidth - start.left - VIEWPORT_MARGIN)}px`;
          }
          if (direction.includes('s')) {
            dialog.style.height = `${clamp(start.height + deltaY, minHeight, window.innerHeight - start.top - VIEWPORT_MARGIN)}px`;
          }
        });
      });
      dialog.append(handle);
    }
  }

  /**
   * 打开对话框。
   * @param {object} options 选项：
   *   title 标题；content 内容（元素或文本）；buttons 按钮数组；
   *   kind 'dialog'（默认，固定大小、不可调整）或 'page'（弹出页面，可调整大小）；
   *   modal 是否模态，默认 true；closable 是否可用右上角 × 与 Esc 关闭，默认 true；
   *   role 'dialog'（默认）或 'alertdialog'；width/height 初始尺寸（像素）；minWidth/minHeight 调整时的下限；
   *   resizable 弹出页面是否可调整，默认 true；draggable 是否可按住标题行拖动，默认 true；
   *   initialFocus 'default'|'cancel'|'first'|元素；onClose 关闭时回调；
   *   beforeClose({ reason }) 用户经 ×、Esc 或取消按钮关闭前调用，返回 false（或 resolve 为 false）时保持打开，程序调用 close() 不经过它。
   *   每个按钮：{ id, text, variant, isDefault, isCancel, disabled, onClick(handle) }，onClick 返回 false（或 resolve 为 false）时保持打开。
   * @returns {object} 句柄：element、bodyElement、footerElement、closed（关闭时 resolve { reason, buttonId }）、
   *   close(reason)、requestClose(reason)（先经 beforeClose 询问）、setTitle(text)、setButtonDisabled(id, disabled)、getButton(id)。
   */
  aiUi.openDialog = function (options) {
    const settings = options || {};
    const isPage = settings.kind === 'page';
    const config = {
      title: settings.title || '',
      modal: settings.modal !== false,
      closable: settings.closable !== false,
      role: settings.role || 'dialog',
      resizable: isPage && settings.resizable !== false,
      draggable: settings.draggable !== false,
      buttons: settings.buttons || [],
      initialFocus: settings.initialFocus,
      onClose: settings.onClose,
      beforeClose: settings.beforeClose
    };
    const width = settings.width || (isPage ? DEFAULT_PAGE_WIDTH : DEFAULT_DIALOG_WIDTH);
    const minWidth = settings.minWidth || DEFAULT_MIN_WIDTH;
    const minHeight = settings.minHeight || DEFAULT_MIN_HEIGHT;

    const layer = aiUi.layer();
    const titleId = aiUi.uid('ui-dialog-title');
    const bodyId = aiUi.uid('ui-dialog-body');
    const previousFocus = document.activeElement;

    const closeButton = config.closable
      ? aiUi.h(
          'button',
          {
            class: 'ui-dialog__close',
            attrs: { type: 'button', 'aria-label': CLOSE_LABEL, title: CLOSE_LABEL },
            on: { click: () => void handle.requestClose('close') }
          },
          aiUi.h('span', { class: 'ui-dialog__close-icon', attrs: { 'aria-hidden': 'true' } })
        )
      : null;
    const titleElement = aiUi.h('span', { class: 'ui-dialog__title', text: config.title, attrs: { id: titleId } });
    const titlebar = aiUi.h('div', { class: 'ui-dialog__titlebar' }, titleElement, closeButton);
    const body = aiUi.h('div', { class: 'ui-dialog__body', attrs: { id: bodyId } });
    if (settings.content !== undefined) body.append(settings.content);
    const footer = config.buttons.length > 0 ? aiUi.h('div', { class: 'ui-dialog__footer' }) : null;

    const dialog = aiUi.h(
      'div',
      {
        class: isPage ? 'ui-dialog ui-dialog--page' : 'ui-dialog',
        attrs: {
          role: config.role,
          'aria-modal': String(config.modal),
          'aria-labelledby': titleId,
          'aria-describedby': bodyId,
          tabindex: '-1'
        }
      },
      titlebar,
      body,
      footer
    );
    dialog.style.width = `${width}px`;
    if (settings.height) dialog.style.height = `${settings.height}px`;
    if (config.resizable) {
      dialog.style.minWidth = `${minWidth}px`;
      dialog.style.minHeight = `${minHeight}px`;
    }

    // 按钮：忙碌（异步处理中）时整体禁用，防止重复触发。
    const buttonControls = new Map();
    const disabledById = new Map();
    let isBusy = false;
    let defaultButton = null;
    let cancelButton = null;

    function applyButtonStates() {
      for (const [id, control] of buttonControls) control.setDisabled(isBusy || Boolean(disabledById.get(id)));
    }

    async function activate(spec) {
      if (isBusy) return;
      isBusy = true;
      applyButtonStates();
      let keepOpen = false;
      try {
        if (spec.onClick) keepOpen = (await spec.onClick(handle)) === false;
      } finally {
        isBusy = false;
        applyButtonStates();
      }
      if (keepOpen) return;
      if (spec.isCancel) await handle.requestClose('cancel', spec.id);
      else handle.close('button', spec.id);
    }

    config.buttons.forEach((spec, index) => {
      const id = spec.id || `button-${index}`;
      const control = aiUi.button({ text: spec.text, variant: spec.variant, onClick: () => void activate({ ...spec, id }) });
      buttonControls.set(id, control);
      disabledById.set(id, Boolean(spec.disabled));
      footer.append(control.element);
      if (spec.isDefault) defaultButton = control;
      if (spec.isCancel) cancelButton = control;
    });
    applyButtonStates();

    let resolveClosed = () => undefined;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    let isClosed = false;
    let isAskingToClose = false;

    const record = { config, dialog, overlay: null, defaultButton, handle: null };
    const handle = {
      element: dialog,
      bodyElement: body,
      footerElement: footer,
      closed,
      close(reason, buttonId) {
        if (isClosed) return;
        isClosed = true;
        stack.splice(stack.indexOf(record), 1);
        if (record.stopObserving) record.stopObserving();
        dialog.remove();
        if (record.overlay) record.overlay.remove();
        updateInert();
        removeListenersIfIdle();
        if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
        const result = { reason: reason || 'api', buttonId };
        if (config.onClose) config.onClose(result);
        resolveClosed(result);
      },
      async requestClose(reason, buttonId) {
        if (isClosed || isAskingToClose) return;
        if (config.beforeClose) {
          isAskingToClose = true;
          try {
            if ((await config.beforeClose({ reason })) === false) return;
          } finally {
            isAskingToClose = false;
          }
        }
        handle.close(reason, buttonId);
      },
      setTitle(text) {
        titleElement.textContent = text;
      },
      setButtonDisabled(id, disabled) {
        disabledById.set(id, disabled);
        applyButtonStates();
      },
      getButton(id) {
        return buttonControls.get(id);
      }
    };
    record.handle = handle;
    record.defaultButton = defaultButton;

    if (config.modal) {
      record.overlay = aiUi.h('div', { class: 'ui-overlay', on: { pointerdown: (event) => event.preventDefault() } });
      layer.append(record.overlay);
    }
    layer.append(dialog);
    if (config.resizable) attachResizeHandles(dialog, minWidth, minHeight);
    if (config.draggable) attachDrag(dialog, titlebar);
    dialog.addEventListener('pointerdown', () => {
      if (stack[stack.length - 1] !== record) bringToFront(record);
    });

    const cascadeIndex = stack.filter((other) => !other.config.modal).length;
    stack.push(record);
    bringToFront(record);
    installListeners();
    updateInert();
    placeDialog(dialog, config.modal ? 0 : cascadeIndex);
    // 内容之后才增高（表单先显示“加载中”再渲染字段）时，居中时的位置会让对话框下沿超出窗口，需要重新收回。
    if (typeof window.ResizeObserver === 'function') {
      const observer = new window.ResizeObserver(() => keepInViewport(dialog));
      observer.observe(dialog);
      record.stopObserving = () => observer.disconnect();
    }

    resolveInitialFocus(record, body, cancelButton, closeButton).focus();
    return handle;
  };

  /** 决定对话框打开后的初始焦点位置。 */
  function resolveInitialFocus(record, body, cancelButton, closeButton) {
    const target = record.config.initialFocus;
    if (target instanceof HTMLElement) return target;
    if (target === 'cancel' && cancelButton) return cancelButton.element;
    const firstInBody = listFocusable(body)[0];
    if (target === 'first' && firstInBody) return firstInBody;
    if (record.dialog.classList.contains('ui-dialog--page') && firstInBody) return firstInBody;
    if (record.defaultButton) return record.defaultButton.element;
    return firstInBody || closeButton || record.dialog;
  }

  /** 把消息与明细列表组装为对话框内容。 */
  function createMessageContent(message, details) {
    const paragraphs = (Array.isArray(message) ? message : [message]).filter(Boolean);
    const list =
      details && details.length > 0
        ? aiUi.h('ul', { class: 'ui-message__details' }, details.map((item) => aiUi.h('li', { text: item })))
        : null;
    return aiUi.h('div', { class: 'ui-message' }, paragraphs.map((text) => aiUi.h('p', { text })), list);
  }

  /**
   * 提示对话框：只有一个“确定”按钮。
   * @param {{ title?: string, message: string|string[], okText?: string, modal?: boolean }} options 选项。
   * @returns {Promise<void>} 关闭后 resolve。
   */
  aiUi.alert = async function (options) {
    const handle = aiUi.openDialog({
      title: options.title || DEFAULT_ALERT_TITLE,
      modal: options.modal,
      role: 'alertdialog',
      content: createMessageContent(options.message, options.details),
      buttons: [{ id: 'ok', text: options.okText || OK_TEXT, variant: 'primary', isDefault: true, isCancel: true }]
    });
    await handle.closed;
  };

  /**
   * 确认对话框：确定与取消两个按钮。
   * @param {{ title?: string, message: string|string[], details?: string[], confirmText?: string, cancelText?: string,
   *   variant?: 'primary'|'danger', modal?: boolean }} options 选项：variant 为 danger 时确定按钮为红色，初始焦点在取消按钮。
   * @returns {Promise<boolean>} 用户点了确定为 true，取消、关闭或按 Esc 为 false。
   */
  aiUi.confirm = async function (options) {
    const variant = options.variant || 'primary';
    const handle = aiUi.openDialog({
      title: options.title || DEFAULT_CONFIRM_TITLE,
      modal: options.modal,
      role: 'alertdialog',
      content: createMessageContent(options.message, options.details),
      initialFocus: variant === 'danger' ? 'cancel' : 'default',
      buttons: [
        { id: 'confirm', text: options.confirmText || OK_TEXT, variant, isDefault: true },
        { id: 'cancel', text: options.cancelText || CANCEL_TEXT, isCancel: true }
      ]
    });
    const result = await handle.closed;
    return result.buttonId === 'confirm';
  };

  /**
   * 删除确认对话框：红色提示要求在输入框中输入名称，输入一致才能点“删除”。
   * @param {{ title?: string, message: string|string[], details?: string[], confirmName: string, nameLabel?: string,
   *   deleteText?: string, cancelText?: string, modal?: boolean }} options 选项：
   *   confirmName 需要输入的名称（区分大小写，完全一致）；nameLabel 名称的称呼，如“项目名称”。
   * @returns {Promise<boolean>} 确认删除为 true，其余为 false。
   */
  aiUi.confirmDelete = async function (options) {
    const confirmName = options.confirmName;
    if (!confirmName) throw new Error('confirmDelete 需要 confirmName。');
    const nameLabel = options.nameLabel || '名称';

    const input = aiUi.textInput({
      ariaLabel: `输入${nameLabel}以确认删除`,
      placeholder: confirmName,
      onChange: (value) => handle.setButtonDisabled('confirm', value !== confirmName)
    });
    const notice = aiUi.h(
      'div',
      { class: 'ui-danger-notice' },
      aiUi.h(
        'p',
        {},
        `请在下方输入框中输入${nameLabel} `,
        aiUi.h('strong', { class: 'ui-danger-notice__name', text: confirmName }),
        ' 以确认删除。此操作无法撤销。'
      )
    );
    const content = aiUi.h(
      'div',
      { class: 'ui-message' },
      createMessageContent(options.message, options.details),
      notice,
      input.element
    );

    const handle = aiUi.openDialog({
      title: options.title || DEFAULT_DELETE_TITLE,
      modal: options.modal,
      role: 'alertdialog',
      content,
      initialFocus: input.focusTarget,
      buttons: [
        { id: 'confirm', text: options.deleteText || DELETE_TEXT, variant: 'danger', isDefault: true, disabled: true },
        { id: 'cancel', text: options.cancelText || CANCEL_TEXT, isCancel: true }
      ]
    });
    const result = await handle.closed;
    return result.buttonId === 'confirm';
  };

  /**
   * 弹出页面：可调整大小（右边、下边、右下角）的对话框，内容由调用方提供。
   * @param {object} options 同 openDialog；kind 固定为 'page'，可用 width/height/minWidth/minHeight 控制尺寸。
   * @returns {object} 对话框句柄。
   */
  aiUi.openPage = function (options) {
    return aiUi.openDialog({ ...options, kind: 'page' });
  };
})();
