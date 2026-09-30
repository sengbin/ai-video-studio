// ------------------------------------------------------------------------
// 名称：form-runtime.js
// 说明：表单引擎：从宿主取得表单描述并渲染控件，负责即时校验、唯一性检查、提交与取消。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求名称与 src/app/forms/form-handlers.ts 一致；字段值一律以文本传输。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_INIT = 'form.init';
  const REQUEST_CHECK_FIELD = 'form.checkField';
  const REQUEST_SUBMIT = 'form.submit';
  const REQUEST_CANCEL = 'form.cancel';

  const CUSTOM_OPTION_VALUE = '__custom__';
  const CUSTOM_OPTION_LABEL = '其他（手动输入）';
  const EMPTY_OPTION_LABEL = '请选择';
  const REQUIRED_PREFIX = '必填，';
  const FORM_LEVEL_ERROR_KEY = '';
  const CANCEL_LABEL = '取消';
  const SUBMITTING_LABEL = '保存中…';

  const root = document.getElementById('app');
  /** 字段键 → 字段控制器，按渲染顺序保存。 */
  const controllers = new Map();
  let schema = null;
  let initialSnapshot = '';
  let isSubmitting = false;
  let summaryElement = null;
  let submitButton = null;

  /**
   * 创建元素。
   * @param {string} tag 标签名。
   * @param {string} [className] 类名。
   * @param {Record<string, string>} [attributes] 属性。
   */
  function createElement(tag, className, attributes) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    for (const [name, value] of Object.entries(attributes || {})) element.setAttribute(name, value);
    return element;
  }

  /** 读取全部字段的当前值。 */
  function collectValues() {
    const values = {};
    for (const [key, controller] of controllers) values[key] = controller.getValue();
    return values;
  }

  /** 表单相对初始状态是否有修改。 */
  function isDirty() {
    return JSON.stringify(collectValues()) !== initialSnapshot;
  }

  /**
   * 本地校验一个字段：必填与长度。
   * @returns {string} 错误提示；无错误返回空串。
   */
  function validateLocally(controller) {
    const { field } = controller;
    const text = controller.getValue().trim();
    if (text.length === 0) return field.required ? `${field.label}不能为空。` : '';
    if (field.maxLength !== undefined && text.length > field.maxLength) {
      return `${field.label}不能超过 ${field.maxLength} 字（当前 ${text.length} 字）。`;
    }
    return '';
  }

  /**
   * 创建下拉框控件，可选带“其他（手动输入）”。
   * @returns {{ element: HTMLElement, input: HTMLElement, getValue: () => string }}
   */
  function createSelectControl(field, id, initialValue, onChange) {
    const wrapper = createElement('div');
    const select = createElement('select', 'field-select', { id });
    const options = field.options || [];
    select.append(new Option(EMPTY_OPTION_LABEL, ''));
    for (const option of options) select.append(new Option(option, option));
    if (field.allowCustom) select.append(new Option(CUSTOM_OPTION_LABEL, CUSTOM_OPTION_VALUE));

    const customInput = field.allowCustom
      ? createElement('input', 'field-input field-custom-input', { type: 'text', 'aria-label': `${field.label}（手动输入）` })
      : null;
    wrapper.append(select);
    if (customInput) {
      customInput.hidden = true;
      wrapper.append(customInput);
    }

    if (initialValue && options.includes(initialValue)) {
      select.value = initialValue;
    } else if (initialValue && customInput) {
      select.value = CUSTOM_OPTION_VALUE;
      customInput.value = initialValue;
      customInput.hidden = false;
    }

    select.addEventListener('change', () => {
      if (customInput) {
        const isCustom = select.value === CUSTOM_OPTION_VALUE;
        customInput.hidden = !isCustom;
        if (isCustom) customInput.focus();
      }
      onChange();
    });
    if (customInput) customInput.addEventListener('input', onChange);

    return {
      element: wrapper,
      input: select,
      getValue: () => (customInput && select.value === CUSTOM_OPTION_VALUE ? customInput.value : select.value)
    };
  }

  /** 创建单行或多行文本控件。 */
  function createTextControl(field, id, initialValue, onChange) {
    const isMultiline = field.control === 'textarea';
    const input = isMultiline
      ? createElement('textarea', 'field-textarea', { id })
      : createElement('input', 'field-input', { id, type: 'text' });
    if (field.placeholder) input.setAttribute('placeholder', field.placeholder);
    input.value = initialValue || '';
    input.addEventListener('input', onChange);
    return { element: input, input, getValue: () => input.value };
  }

  /** 渲染一个字段并登记控制器。 */
  function renderField(field, initialValue) {
    const id = `field-${field.key}`;
    const descriptionId = `${id}-description`;
    const errorId = `${id}-error`;

    const container = createElement('div', 'form-field');
    const label = createElement('label', 'field-label', { for: id });
    label.textContent = field.label;
    const description = createElement('p', 'description field-description', { id: descriptionId });
    description.textContent = field.required ? `${REQUIRED_PREFIX}${field.description}` : field.description;
    const error = createElement('p', 'field-error status-error', { id: errorId });
    error.hidden = true;

    const controller = { field, uniqueError: '', uniqueCheckedValue: null };
    const onChange = () => {
      // 内容变化后，此前的错误不再适用，等下次失去焦点或提交时重新校验。
      controller.uniqueError = '';
      controller.uniqueCheckedValue = null;
      setError(controller, '');
    };
    const control = field.control === 'select'
      ? createSelectControl(field, id, initialValue, onChange)
      : createTextControl(field, id, initialValue, onChange);
    control.input.setAttribute('aria-describedby', `${descriptionId} ${errorId}`);

    controller.getValue = control.getValue;
    controller.focus = () => control.input.focus();
    controller.errorElement = error;
    controller.inputElement = control.input;

    container.append(label, description, control.element, error);
    controllers.set(field.key, controller);

    // 失去焦点时校验；焦点在下拉框与其自定义输入框之间移动时不算离开字段。
    container.addEventListener('focusout', (event) => {
      if (event.relatedTarget && container.contains(event.relatedTarget)) return;
      void validateOnBlur(controller);
    });
    return container;
  }

  /** 设置或清除字段错误，并同步无障碍状态。 */
  function setError(controller, message) {
    controller.errorElement.textContent = message;
    controller.errorElement.hidden = message === '';
    if (message) controller.inputElement.setAttribute('aria-invalid', 'true');
    else controller.inputElement.removeAttribute('aria-invalid');
  }

  /** 字段失去焦点：先本地校验，再按需向宿主检查唯一性。 */
  async function validateOnBlur(controller) {
    const localError = validateLocally(controller);
    if (localError) {
      setError(controller, localError);
      return;
    }
    const value = controller.getValue().trim();
    if (!controller.field.checkUnique || value === '' || controller.uniqueCheckedValue === value) return;

    try {
      const result = await window.hostBridge.request(REQUEST_CHECK_FIELD, { key: controller.field.key, value });
      // 等待期间用户又改了内容时，丢弃过期结果。
      if (controller.getValue().trim() !== value) return;
      controller.uniqueCheckedValue = value;
      controller.uniqueError = result && result.error ? result.error : '';
      setError(controller, controller.uniqueError);
    } catch {
      // 检查失败不阻止继续填写，提交时宿主会再次校验。
    }
  }

  /** 校验全部字段，返回有错误的字段控制器。 */
  function validateAll() {
    const invalid = [];
    for (const controller of controllers.values()) {
      const message = validateLocally(controller) || controller.uniqueError;
      setError(controller, message);
      if (message) invalid.push(controller);
    }
    return invalid;
  }

  /** 显示或清除表单顶部的错误摘要。 */
  function showSummary(message) {
    summaryElement.textContent = message;
    summaryElement.hidden = message === '';
    if (message) summaryElement.focus();
  }

  /** 切换提交中状态：禁止重复提交并更新按钮文字。 */
  function setSubmitting(value) {
    isSubmitting = value;
    submitButton.disabled = value;
    submitButton.textContent = value ? SUBMITTING_LABEL : schema.submitLabel;
  }

  /** 应用宿主返回的错误；返回是否有字段收到了错误。 */
  function applyServerError(error) {
    const fieldErrors = (error && error.fieldErrors) || {};
    let hasFieldError = false;
    for (const [key, message] of Object.entries(fieldErrors)) {
      const controller = controllers.get(key);
      if (controller) {
        setError(controller, message);
        hasFieldError = true;
      }
    }
    const summary = fieldErrors[FORM_LEVEL_ERROR_KEY] || (!hasFieldError && error && error.message) || '';
    showSummary(hasFieldError && !summary ? '请修改标出的字段后重新保存。' : summary);
    return hasFieldError;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isSubmitting) return;
    showSummary('');

    const invalid = validateAll();
    if (invalid.length > 0) {
      showSummary(`有 ${invalid.length} 项需要修改，请检查标出的字段。`);
      invalid[0].focus();
      return;
    }

    setSubmitting(true);
    try {
      await window.hostBridge.request(REQUEST_SUBMIT, { values: collectValues() });
      // 提交成功后宿主会关闭面板；保持禁用避免重复提交。
      submitButton.textContent = '已保存';
    } catch (error) {
      setSubmitting(false);
      applyServerError(error);
    }
  }

  async function handleCancel() {
    try {
      await window.hostBridge.request(REQUEST_CANCEL, { dirty: isDirty() });
    } catch (error) {
      showSummary((error && error.message) || '操作失败，请重试。');
    }
  }

  /** 渲染整个表单。 */
  function renderForm(initResult) {
    schema = initResult.schema;
    const values = initResult.values || {};
    root.textContent = '';

    const page = createElement('div', 'form-page');
    const title = createElement('h1');
    title.textContent = schema.title;
    summaryElement = createElement('div', 'form-error-summary status-error', { role: 'alert', tabindex: '-1' });
    summaryElement.hidden = true;

    const form = createElement('form', '', { novalidate: 'novalidate' });
    for (const field of schema.fields) form.append(renderField(field, values[field.key] || ''));

    const actions = createElement('div', 'form-actions');
    const cancelButton = createElement('button', 'button button-secondary', { type: 'button' });
    cancelButton.textContent = CANCEL_LABEL;
    cancelButton.addEventListener('click', () => void handleCancel());
    submitButton = createElement('button', 'button button-primary', { type: 'submit' });
    submitButton.textContent = schema.submitLabel;
    actions.append(cancelButton, submitButton);
    form.append(actions);
    form.addEventListener('submit', (event) => void handleSubmit(event));

    page.append(title, summaryElement, form);
    root.append(page);
    initialSnapshot = JSON.stringify(collectValues());

    const firstController = controllers.values().next().value;
    if (firstController) firstController.focus();
  }

  window.hostBridge
    .request(REQUEST_INIT)
    .then(renderForm)
    .catch((error) => {
      root.textContent = (error && error.message) || '表单加载失败。';
    });
})();
