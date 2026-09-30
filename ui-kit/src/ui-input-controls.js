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
   * @param {{ id?: string, value?: string, placeholder?: string, rows?: number, ariaLabel?: string,
   *   disabled?: boolean, onChange?: (value: string) => void }} [options] 选项。
   * @returns 控件对象，getValue 返回文本。
   */
  aiUi.textArea = function (options) {
    const settings = options || {};
    const textarea = aiUi.h('textarea', {
      class: 'ui-textarea__field',
      attrs: {
        id: settings.id,
        placeholder: settings.placeholder,
        rows: settings.rows,
        'aria-label': settings.ariaLabel
      }
    });
    textarea.value = toText(settings.value);
    const grip = aiUi.h('div', { class: 'ui-textarea__grip', attrs: { 'aria-hidden': 'true' } });
    const element = aiUi.h('div', { class: 'ui-textarea' }, textarea, grip);

    const control = aiUi.makeControl({
      element,
      focusTarget: textarea,
      labelable: true,
      onChange: settings.onChange,
      getValue: () => textarea.value,
      setValue: (value) => {
        textarea.value = toText(value);
      },
      setDisabled: (disabled) => {
        textarea.disabled = disabled;
      }
    });
    control.setDisabled(Boolean(settings.disabled));
    textarea.addEventListener('input', () => control.notifyChange());

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
