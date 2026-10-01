// ------------------------------------------------------------------------
// 名称：form-runtime.js
// 说明：表单引擎：向宿主打开表单，在页内弹出页面中用界面组件库渲染控件，负责即时校验、唯一性检查、提交与放弃修改确认。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求名称与 src/app/forms/form-handlers.ts 一致；字段值一律以文本传输（布尔为 true/false，多选为 JSON 数组文本）；页面通过 aiForm.open 使用。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_OPEN = 'form.open';
  const REQUEST_CHECK_FIELD = 'form.checkField';
  const REQUEST_SUBMIT = 'form.submit';
  const REQUEST_CLOSE = 'form.close';

  const FORM_LEVEL_ERROR_KEY = '';
  const FORM_PAGE_WIDTH = 560;
  const FORM_PAGE_MIN_WIDTH = 400;
  const CANCEL_LABEL = '取消';
  const SUBMITTING_LABEL = '保存中…';
  const LOAD_FAILED_TITLE = '无法打开表单';
  const GENERIC_ERROR_MESSAGE = '操作失败，请重试。';
  const DISCARD_TITLE = '放弃修改';
  const DISCARD_MESSAGE = '放弃未保存的修改？';
  const DISCARD_CONFIRM_TEXT = '放弃修改';
  const DISCARD_CANCEL_TEXT = '继续编辑';
  const CHOOSE_ONE_CONTROLS = ['select', 'radio'];

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
      case 'file': {
        const control = aiUi.filePicker({
          accept: fieldSchema.accept || [],
          multiple: Boolean(fieldSchema.multiple),
          maxFiles: fieldSchema.maxFiles,
          maxFileBytes: fieldSchema.maxFileBytes,
          preview: fieldSchema.preview,
          ariaLabel: fieldSchema.label
        });
        // 编辑时带出已保存的文件（与提交格式相同的 JSON 数组）。
        control.setValue(parseList(initialText));
        return { kind: 'files', control };
      }
      default:
        return { kind: 'text', control: aiUi.textInput({ value: initialText, placeholder: fieldSchema.placeholder }) };
    }
  }

  /**
   * 本地校验一个字段：必填与长度。
   * @returns {string} 错误提示；无错误返回空串。
   */
  function validateLocally(entry) {
    const fieldSchema = entry.schema;
    if (entry.kind === 'boolean') return '';
    if (entry.kind === 'list' || entry.kind === 'files') {
      const unit = entry.kind === 'files' ? '个文件' : '项';
      return fieldSchema.required && entry.control.getValue().length === 0 ? `${fieldSchema.label}至少选择一${unit}。` : '';
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

  /** 读取字段当前值，转换为提交用的文本。 */
  function readText(entry) {
    const value = entry.control.getValue();
    if (entry.kind === 'boolean') return value ? 'true' : 'false';
    if (entry.kind === 'list' || entry.kind === 'files') return JSON.stringify(value);
    return value;
  }

  /**
   * 为一次打开的表单创建界面与状态。
   * @param {{ formId: number, schema: object, values?: object }} session 宿主返回的表单会话。
   * @param {{ onCancel: () => void, onSaved: () => void }} handlers 点“取消”与保存成功后的动作。
   * @returns {{ element: HTMLElement, isDirty: () => boolean, isSubmitting: () => boolean }}
   */
  function createForm(session, handlers) {
    const { formId, schema } = session;
    const values = session.values || {};
    /** 字段键 → 字段条目，按渲染顺序保存。 */
    const entries = new Map();
    let initialSnapshot = '';
    let isSubmitting = false;

    const summaryElement = aiUi.h('div', {
      class: 'form-error-summary status-error',
      hidden: true,
      attrs: { role: 'alert', tabindex: '-1' }
    });

    function collectValues() {
      const collected = {};
      for (const [key, entry] of entries) collected[key] = readText(entry);
      return collected;
    }

    /** 显示或清除表单顶部的错误摘要。 */
    function showSummary(message) {
      summaryElement.textContent = message;
      summaryElement.hidden = message === '';
      if (message) summaryElement.focus();
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
        const result = await window.hostBridge.request(REQUEST_CHECK_FIELD, { formId, key: entry.schema.key, value });
        // 等待期间用户又改了内容时，丢弃过期结果。
        if (entry.control.getValue().trim() !== value) return;
        entry.uniqueCheckedValue = value;
        entry.uniqueError = result && result.error ? result.error : '';
        entry.field.setError(entry.uniqueError);
      } catch {
        // 检查失败不阻止继续填写，提交时宿主会再次校验。
      }
    }

    /** 渲染一个字段并登记条目。 */
    function renderField(fieldSchema, initialText) {
      const { kind, control } = createControl(fieldSchema, initialText);
      const field = aiUi.field({
        label: kind === 'boolean' ? undefined : fieldSchema.label,
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
      showSummary(hasFieldError && !summary ? '请修改标出的字段后重新保存。' : summary || GENERIC_ERROR_MESSAGE);
    }

    const cancelButton = aiUi.button({ text: CANCEL_LABEL, onClick: handlers.onCancel });
    const submitButton = aiUi.button({ text: schema.submitLabel, variant: 'primary', type: 'submit' });

    /** 切换提交中状态：禁止重复提交并更新按钮文字。 */
    function setSubmitting(value) {
      isSubmitting = value;
      submitButton.setDisabled(value);
      submitButton.setText(value ? SUBMITTING_LABEL : schema.submitLabel);
    }

    /** 校验并提交：成功后由页面关闭弹出页面；失败时保留输入并显示错误。 */
    async function handleSubmit(event) {
      event.preventDefault();
      if (isSubmitting) return;
      showSummary('');
      // 文件还在读取时先等它读完，避免提交不完整的内容。
      await Promise.all([...entries.values()].map((entry) => (entry.control.whenReady ? entry.control.whenReady() : undefined)));
      const invalid = validateAll();
      if (invalid.length > 0) {
        showSummary(`有 ${invalid.length} 项需要修改，请检查标出的字段。`);
        invalid[0].control.focus();
        return;
      }
      setSubmitting(true);
      try {
        await window.hostBridge.request(REQUEST_SUBMIT, { formId, values: collectValues() });
        // 保持禁用直到弹出页面关闭，避免重复提交。
        handlers.onSaved();
      } catch (error) {
        setSubmitting(false);
        applyServerError(error);
      }
    }

    const form = aiUi.h(
      'form',
      { attrs: { novalidate: 'novalidate' }, on: { submit: (event) => void handleSubmit(event) } },
      schema.fields.map((fieldSchema) => renderField(fieldSchema, values[fieldSchema.key] || '')),
      aiUi.h('div', { class: 'form-actions' }, cancelButton.element, submitButton.element)
    );
    const element = aiUi.h('div', {}, summaryElement, form);
    initialSnapshot = JSON.stringify(collectValues());

    return {
      element,
      isDirty: () => JSON.stringify(collectValues()) !== initialSnapshot,
      isSubmitting: () => isSubmitting
    };
  }

  /** 提交中不允许关闭；有修改时用页内确认框询问是否放弃，返回 true 表示可以关闭。 */
  async function confirmDiscard(form) {
    if (form.isSubmitting()) return false;
    if (!form.isDirty()) return true;
    return aiUi.confirm({
      title: DISCARD_TITLE,
      message: DISCARD_MESSAGE,
      confirmText: DISCARD_CONFIRM_TEXT,
      cancelText: DISCARD_CANCEL_TEXT,
      variant: 'danger'
    });
  }

  /**
   * 打开表单：向宿主请求表单会话，成功后弹出页面；点“取消”、右上角 × 或按 Esc 时，有修改先确认放弃。
   * @param {{ form: string, params?: unknown }} options 表单名称与打开参数（如编辑时的 { id }）。
   * @returns {Promise<boolean>} 弹出页面关闭后 resolve：已保存为 true，否则为 false；表单打开失败时提示并返回 false。
   */
  async function open(options) {
    let session;
    try {
      session = await window.hostBridge.request(REQUEST_OPEN, { form: options.form, params: options.params });
    } catch (error) {
      await aiUi.alert({ title: LOAD_FAILED_TITLE, message: (error && error.message) || GENERIC_ERROR_MESSAGE });
      return false;
    }

    let isSaved = false;
    /** 弹出页面的句柄；按钮回调只在页面创建后才会被触发。 */
    let page = null;
    const form = createForm(session, {
      onCancel: () => void page.requestClose('cancel'),
      onSaved: () => {
        isSaved = true;
        page.close('button');
      }
    });
    page = aiUi.openPage({
      title: session.schema.title,
      content: form.element,
      width: FORM_PAGE_WIDTH,
      minWidth: FORM_PAGE_MIN_WIDTH,
      beforeClose: () => confirmDiscard(form)
    });
    await page.closed;
    // 已提交的会话宿主已释放；这里通知宿主释放未提交的会话，失败不影响界面。
    window.hostBridge.request(REQUEST_CLOSE, { formId: session.formId }).catch(() => undefined);
    return isSaved;
  }

  window.aiForm = { open };
})();
