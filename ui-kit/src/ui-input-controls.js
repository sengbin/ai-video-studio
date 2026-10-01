// ------------------------------------------------------------------------
// 名称：ui-input-controls.js
// 说明：界面组件库的文本控件：单行输入框和多行文本框（右下角有自绘的高度调整把手）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js；返回统一的控件对象，用法见 docs/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  /** 值统一转为文本，空值按空串。 */
  function toText(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  /**
   * 创建单行输入框。
   * @param {{ id?: string, value?: string, placeholder?: string, type?: 'text'|'search'|'password', ariaLabel?: string,
   *   disabled?: boolean, onChange?: (value: string) => void, onEnter?: () => void }} [options] 选项。
   * @returns 控件对象，getValue 返回文本。
   */
  aiUi.textInput = function (options) {
    const settings = options || {};
    const input = aiUi.h('input', {
      class: 'ui-input__field',
      attrs: {
        type: settings.type || 'text',
        id: settings.id,
        placeholder: settings.placeholder,
        'aria-label': settings.ariaLabel,
        autocomplete: 'off'
      }
    });
    input.value = toText(settings.value);
    const element = aiUi.h('div', { class: 'ui-input' }, input);

    const control = aiUi.makeControl({
      element,
      focusTarget: input,
      labelable: true,
      onChange: settings.onChange,
      getValue: () => input.value,
      setValue: (value) => {
        input.value = toText(value);
      },
      setDisabled: (disabled) => {
        input.disabled = disabled;
      }
    });
    control.setDisabled(Boolean(settings.disabled));
    input.addEventListener('input', () => control.notifyChange());
    if (settings.onEnter) {
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') settings.onEnter();
      });
    }
    return control;
  };

  /**
   * 创建多行文本框。
   * @param {{ id?: string, value?: string, placeholder?: string, rows?: number, minRows?: number, maxRows?: number,
   *   ariaLabel?: string, disabled?: boolean, onChange?: (value: string) => void }} [options] 选项。
   *   传 maxRows 时高度按内容自适应：至少 minRows 行（默认 1），最多 maxRows 行，再多出现滚动条；此时没有高度调整把手。
   * @returns 控件对象，getValue 返回文本。
   */
  aiUi.textArea = function (options) {
    const settings = options || {};
    const autoSize = typeof settings.maxRows === 'number';
    const textarea = aiUi.h('textarea', {
      class: 'ui-textarea__field',
      attrs: {
        id: settings.id,
        placeholder: settings.placeholder,
        rows: autoSize ? 1 : settings.rows,
        'aria-label': settings.ariaLabel
      }
    });
    textarea.value = toText(settings.value);
    const grip = aiUi.h('div', { class: 'ui-textarea__grip', attrs: { 'aria-hidden': 'true' } });
    const element = aiUi.h('div', { class: autoSize ? 'ui-textarea ui-textarea--auto' : 'ui-textarea' }, textarea, grip);

    /** 按内容计算高度：在 minRows 与 maxRows 行之间，超过上限时显示滚动条。 */
    function fit() {
      if (!autoSize) return;
      // 脱离页面时量不出换行，保持原高度，下一帧挂回页面后再计算。
      if (!textarea.isConnected) {
        window.requestAnimationFrame(() => {
          if (textarea.isConnected) fit();
        });
        return;
      }
      textarea.style.height = 'auto';
      const style = window.getComputedStyle(textarea);
      const lineHeight = parseFloat(style.lineHeight) || 16;
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const min = lineHeight * (settings.minRows || 1) + padding;
      const max = lineHeight * settings.maxRows + padding;
      const content = textarea.scrollHeight;
      textarea.style.height = `${Math.min(Math.max(content, min), max)}px`;
      textarea.style.overflowY = content > max ? 'auto' : 'hidden';
    }

    const control = aiUi.makeControl({
      element,
      focusTarget: textarea,
      labelable: true,
      onChange: settings.onChange,
      getValue: () => textarea.value,
      setValue: (value) => {
        textarea.value = toText(value);
        fit();
      },
      setDisabled: (disabled) => {
        textarea.disabled = disabled;
      }
    });
    control.setDisabled(Boolean(settings.disabled));
    textarea.addEventListener('input', () => {
      fit();
      control.notifyChange();
    });

    if (autoSize) {
      fit();
      // 创建时还没有挂到页面，量不出换行；挂上后以及宽度变化时重新计算。
      if (typeof window.ResizeObserver === 'function') {
        let lastWidth = 0;
        new window.ResizeObserver(() => {
          const width = element.clientWidth;
          if (width === lastWidth) return;
          lastWidth = width;
          fit();
        }).observe(element);
      }
    }

    // 右下角把手只调整高度，下限由样式中的 min-height 保证。
    grip.addEventListener('mousedown', (event) => event.preventDefault());
    grip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || control.isDisabled()) return;
      const startHeight = textarea.getBoundingClientRect().height;
      aiUi.trackPointer(grip, event, (_deltaX, deltaY) => {
        textarea.style.height = `${Math.max(startHeight + deltaY, 0)}px`;
      });
    });
    return control;
  };
})();
