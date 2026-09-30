// ------------------------------------------------------------------------
// 名称：ui-field.js
// 说明：界面组件库的字段包装：为任意控件加上标签、说明文字和错误提示，并建立无障碍关联。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js；配合 ui-input-controls.js、ui-select.js、ui-choice-controls.js 的控件使用。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  const REQUIRED_PREFIX = '必填，';
  const REQUIRED_ONLY_TEXT = '必填';

  /**
   * 给控件套上字段外壳：标签、说明、控件、错误提示。
   * 有 label 时顺序为“标签、说明、控件、错误”；没有 label（复选框、开关自带文字）时为“控件、说明、错误”。
   * @param {{ label?: string, description?: string, required?: boolean, control: object }} options 选项：
   *   required 为 true 时说明文字以“必填，”开头（没有说明时显示“必填”），不只靠颜色或星号表达。
   * @returns {{ element: HTMLElement, control: object, setError: (message: string) => void, getError: () => string }}
   */
  aiUi.field = function (options) {
    const { label, description, required = false, control } = options;
    const describedBy = [];
    let labelElement = null;
    let descriptionElement = null;

    if (label) {
      const labelId = aiUi.uid('ui-label');
      if (control.labelable) {
        if (!control.focusTarget.id) control.focusTarget.id = aiUi.uid('ui-control');
        labelElement = aiUi.h('label', {
          class: 'ui-field__label',
          text: label,
          attrs: { id: labelId, for: control.focusTarget.id }
        });
      } else {
        labelElement = aiUi.h('div', { class: 'ui-field__label', text: label, attrs: { id: labelId } });
        control.ariaTarget.setAttribute('aria-labelledby', labelId);
      }
    }

    const descriptionText = required ? (description ? `${REQUIRED_PREFIX}${description}` : REQUIRED_ONLY_TEXT) : description;
    if (descriptionText) {
      const descriptionId = aiUi.uid('ui-description');
      descriptionElement = aiUi.h('p', {
        class: labelElement ? 'ui-field__description' : 'ui-field__description ui-field__description--after',
        text: descriptionText,
        attrs: { id: descriptionId }
      });
      describedBy.push(descriptionId);
    }

    const errorId = aiUi.uid('ui-error');
    const errorElement = aiUi.h('p', { class: 'ui-field__error', hidden: true, attrs: { id: errorId, 'aria-live': 'polite' } });
    describedBy.push(errorId);
    control.ariaTarget.setAttribute('aria-describedby', describedBy.join(' '));

    // 子节点中的空值会被 aiUi.h 忽略。
    const element = labelElement
      ? aiUi.h('div', { class: 'ui-field' }, labelElement, descriptionElement, control.element, errorElement)
      : aiUi.h('div', { class: 'ui-field' }, control.element, descriptionElement, errorElement);

    return {
      element,
      control,
      setError(message) {
        errorElement.textContent = message;
        errorElement.hidden = message === '';
        control.setInvalid(message !== '');
      },
      getError() {
        return errorElement.textContent;
      }
    };
  };
})();
