// ------------------------------------------------------------------------
// 名称：form-runtime.js
// 说明：表单引擎：从宿主取得表单描述，用界面组件库渲染控件，负责即时校验、唯一性检查、提交与取消确认。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求名称与 src/app/forms/form-handlers.ts 一致；字段值一律以文本传输（布尔为 true/false，多选为 JSON 数组文本）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_INIT = 'form.init';
  const REQUEST_CHECK_FIELD = 'form.checkField';
  const REQUEST_SUBMIT = 'form.submit';
  const REQUEST_CANCEL = 'form.cancel';

  const FORM_LEVEL_ERROR_KEY = '';
  const CANCEL_LABEL = '取消';
  const SUBMITTING_LABEL = '保存中…';
  const SAVED_LABEL = '已保存';
  const DISCARD_TITLE = '放弃修改';
  const DISCARD_MESSAGE = '放弃未保存的修改？';
  const DISCARD_CONFIRM_TEXT = '放弃修改';
  const DISCARD_CANCEL_TEXT = '继续编辑';
  const CHOOSE_ONE_CONTROLS = ['select', 'radio'];

  const root = document.getElementById('app');
  /** 字段键 → 字段条目，按渲染顺序保存。 */
  const entries = new Map();
  let schema = null;
  let initialSnapshot = '';
  let isSubmitting = false;
  let summaryElement = null;
  let submitButton = null;

  /** 解析多选值文本为数组；无法解析时按空数组。 */
  function parseList(text) {
    try {
      const value = JSON.parse(text || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  /** 按字段描述创建控件，并说明其值的种类：text、boolean 或 list。 */
  function createControl(fieldSchema, initialText) {
    const options = fieldSchema.options || [];
    switch (fieldSchema.control) {
      case 'textarea':
        return { kind: 'text', control: aiUi.textArea({ value: initialText, placeholder: fieldSchema.placeholder }) };
      case 'select':
        return {
          kind: 'text',
          control: aiUi.select({
            options,
            value: initialText,
            allowEmpty: !fieldSchema.required,
            allowCustom: Boolean(fieldSchema.allowCustom)
          })
        };
      case 'radio':
        return { kind: 'text', control: aiUi.radioGroup({ options, value: initialText }) };
      case 'checkbox':
        return { kind: 'boolean', control: aiUi.checkbox({ label: fieldSchema.label, checked: initialText === 'true' }) };
      case 'switch':
        return { kind: 'boolean', control: aiUi.switchControl({ label: fieldSchema.label, checked: initialText === 'true' }) };
      case 'checkboxes':
        return { kind: 'list', control: aiUi.checkboxGroup({ options, value: parseList(initialText) }) };
      default:
        return { kind: 'text', control: aiUi.textInput({ value: initialText, placeholder: fieldSchema.placeholder }) };
    }
  }

  /** 读取字段当前值，转换为提交用的文本。 */
  function readText(entry) {
    const value = entry.control.getValue();
    if (entry.kind === 'boolean') return value ? 'true' : 'false';
    if (entry.kind === 'list') return JSON.stringify(value);
    return value;
  }

  /** 读取全部字段的当前值。 */
  function collectValues() {
    const values = {};
    for (const [key, entry] of entries) values[key] = readText(entry);
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
  function validateLocally(entry) {
    const fieldSchema = entry.schema;
    if (entry.kind === 'boolean') return '';
    if (entry.kind === 'list') {
      return fieldSchema.required && entry.control.getValue().length === 0 ? `${fieldSchema.label}至少选择一项。` : '';
    }
    const text = entry.control.getValue().trim();
    if (text.length === 0) {
      if (!fieldSchema.required) return '';
      return CHOOSE_ONE_CONTROLS.includes(fieldSchema.control) ? `${fieldSchema.label}必须选择。` : `${fieldSchema.label}不能为空。`;
    }
    if (fieldSchema.maxLength !== undefined && text.length > fieldSchema.maxLength) {
      return `${fieldSchema.label}不能超过 ${fieldSchema.maxLength} 字（当前 ${text.length} 字）。`;
    }
    return '';
  }

  /** 渲染一个字段并登记条目。 */
  function renderField(fieldSchema, initialText) {
    const { kind, control } = createControl(fieldSchema, initialText);
    const isInlineLabel = kind === 'boolean';
    const field = aiUi.field({
      label: isInlineLabel ? undefined : fieldSchema.label,
      description: fieldSchema.description,
      required: fieldSchema.required,
      control
    });
    const entry = { schema: fieldSchema, kind, control, field, uniqueError: '', uniqueCheckedValue: null };
    entries.set(fieldSchema.key, entry);

    // 内容变化后，此前的错误不再适用，等下次失去焦点或提交时重新校验。
    control.onChange(() => {
      entry.uniqueError = '';
      entry.uniqueCheckedValue = null;
      field.setError('');
    });
    // 焦点在字段内部的控件之间移动时不算离开字段。
    field.element.addEventListener('focusout', (event) => {
      if (event.relatedTarget && field.element.contains(event.relatedTarget)) return;
      void validateOnBlur(entry);
    });
    return field.element;
  }

  /** 字段失去焦点：先本地校验，再按需向宿主检查唯一性。 */
  async function validateOnBlur(entry) {
    const localError = validateLocally(entry);
    if (localError) {
      entry.field.setError(localError);
      return;
    }
    if (!entry.schema.checkUnique || entry.kind !== 'text') return;
    const value = entry.control.getValue().trim();
    if (value === '' || entry.uniqueCheckedValue === value) return;

    try {
      const result = await window.hostBridge.request(REQUEST_CHECK_FIELD, { key: entry.schema.key, value });
      // 等待期间用户又改了内容时，丢弃过期结果。
      if (entry.control.getValue().trim() !== value) return;
      entry.uniqueCheckedValue = value;
      entry.uniqueError = result && result.error ? result.error : '';
      entry.field.setError(entry.uniqueError);
    } catch {
      // 检查失败不阻止继续填写，提交时宿主会再次校验。
    }
  }

  /** 校验全部字段，返回有错误的字段条目。 */
  function validateAll() {
    const invalid = [];
    for (const entry of entries.values()) {
      const message = validateLocally(entry) || entry.uniqueError;
      entry.field.setError(message);
      if (message) invalid.push(entry);
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
    submitButton.setDisabled(value);
    submitButton.setText(value ? SUBMITTING_LABEL : schema.submitLabel);
  }

  /** 应用宿主返回的错误。 */
  function applyServerError(error) {
    const fieldErrors = (error && error.fieldErrors) || {};
    let hasFieldError = false;
    for (const [key, message] of Object.entries(fieldErrors)) {
      const entry = entries.get(key);
      if (entry) {
        entry.field.setError(message);
        hasFieldError = true;
      }
    }
    const summary = fieldErrors[FORM_LEVEL_ERROR_KEY] || (!hasFieldError && error && error.message) || '';
    showSummary(hasFieldError && !summary ? '请修改标出的字段后重新保存。' : summary);
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (isSubmitting) return;
    showSummary('');

    const invalid = validateAll();
    if (invalid.length > 0) {
      showSummary(`有 ${invalid.length} 项需要修改，请检查标出的字段。`);
      invalid[0].control.focus();
      return;
    }

    setSubmitting(true);
    try {
      await window.hostBridge.request(REQUEST_SUBMIT, { values: collectValues() });
      // 提交成功后宿主会关闭面板；保持禁用避免重复提交。
      submitButton.setText(SAVED_LABEL);
    } catch (error) {
      setSubmitting(false);
      applyServerError(error);
    }
  }

  /** 取消：有修改时先用页内对话框确认放弃，再请求宿主关闭面板。 */
  async function handleCancel() {
    if (isDirty()) {
      const shouldDiscard = await aiUi.confirm({
        title: DISCARD_TITLE,
        message: DISCARD_MESSAGE,
        confirmText: DISCARD_CONFIRM_TEXT,
        cancelText: DISCARD_CANCEL_TEXT,
        variant: 'danger'
      });
      if (!shouldDiscard) return;
    }
    try {
      await window.hostBridge.request(REQUEST_CANCEL);
    } catch (error) {
      showSummary((error && error.message) || '操作失败，请重试。');
    }
  }

  /** 渲染整个表单。 */
  function renderForm(initResult) {
    schema = initResult.schema;
    const values = initResult.values || {};
    root.textContent = '';

    summaryElement = aiUi.h('div', {
      class: 'form-error-summary status-error',
      hidden: true,
      attrs: { role: 'alert', tabindex: '-1' }
    });
    const cancelButton = aiUi.button({ text: CANCEL_LABEL, onClick: () => void handleCancel() });
    submitButton = aiUi.button({ text: schema.submitLabel, variant: 'primary', type: 'submit' });

    const form = aiUi.h(
      'form',
      { attrs: { novalidate: 'novalidate' }, on: { submit: (event) => void handleSubmit(event) } },
      schema.fields.map((fieldSchema) => renderField(fieldSchema, values[fieldSchema.key] || '')),
      aiUi.h('div', { class: 'form-actions' }, cancelButton.element, submitButton.element)
    );
    root.append(aiUi.h('div', { class: 'form-page' }, aiUi.h('h1', { text: schema.title }), summaryElement, form));
    initialSnapshot = JSON.stringify(collectValues());

    const firstEntry = entries.values().next().value;
    if (firstEntry) firstEntry.control.focus();
  }

  window.hostBridge
    .request(REQUEST_INIT)
    .then(renderForm)
    .catch((error) => {
      root.textContent = (error && error.message) || '表单加载失败。';
    });
})();
