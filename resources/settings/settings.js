// ------------------------------------------------------------------------
// 名称：settings.js
// 说明：模型设置页脚本：顶部是文本生成设置（是否启用 Copilot、全局默认文本模型、小说分段方式、每段字数上限），下面是服务商列表，点“设置”弹出该服务商的设置页（启用、访问密钥、设置项、模型开关与能力），全部即时保存。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：请求名称与 src/app/pages/settings-handlers.ts 一致；每个字段旁显示“保存中…”“已保存”“保存失败”；访问密钥只发送给宿主，不回显；“测试连接”用宿主已保存的密钥和设置发起。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'settings.load';
  const REQUEST_UPDATE = 'settings.update';
  const REQUEST_PROVIDER_UPDATE = 'settings.providerUpdate';
  const REQUEST_PROVIDER_SET_KEY = 'settings.providerSetKey';
  const REQUEST_PROVIDER_CLEAR_KEY = 'settings.providerClearKey';
  const REQUEST_PROVIDER_TEST_CONNECTION = 'settings.providerTestConnection';
  const REQUEST_MODEL_SET_ENABLED = 'settings.modelSetEnabled';

  const COPILOT_SWITCH_LABEL = '启用 Copilot 文本模型';
  const SAVING_TEXT = '保存中…';
  const SAVED_TEXT = '已保存';
  const TESTING_TEXT = '正在测试连接…';
  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const API_KEY_FIELD = 'apiKey';
  const KEY_CONFIGURED_TEXT = '已配置';
  const KEY_MISSING_TEXT = '未配置';
  const KEY_PLACEHOLDER_NEW = '粘贴访问密钥';
  const KEY_PLACEHOLDER_REPLACE = '已配置，输入新密钥可更换';
  const SPLIT_MODE_OPTIONS = [
    { value: 'chapter', label: '按章节' },
    { value: 'length', label: '按字数' }
  ];

  const root = document.getElementById('app');

  /** 取错误载荷中的说明文字。 */
  function errorText(error) {
    return (error && error.message) || GENERIC_ERROR_TEXT;
  }

  /** 取错误载荷中某个字段的错误提示；没有则返回空串。 */
  function fieldErrorOf(error, key) {
    return (error && error.fieldErrors && error.fieldErrors[key]) || '';
  }

  /**
   * 创建保存状态文字：显示在字段下方，随保存过程更新。
   * @returns {{ element: HTMLElement, show: (text: string, isError?: boolean) => void }}
   */
  function createSaveStatus() {
    const element = aiUi.h('p', { class: 'settings-status', hidden: true, attrs: { role: 'status' } });
    return {
      element,
      show(text, isError) {
        element.textContent = text;
        element.className = isError ? 'settings-status status-error' : 'settings-status status-success';
        element.hidden = text === '';
      }
    };
  }

  /** 保存一项文本生成设置，并在状态文字中反馈结果。 */
  async function saveSetting(patch, status) {
    status.show(SAVING_TEXT, false);
    try {
      await window.hostBridge.request(REQUEST_UPDATE, patch);
      status.show(SAVED_TEXT, false);
    } catch (error) {
      status.show(`保存失败：${errorText(error)}`, true);
    }
  }

  /** 文本模型区：Copilot 启用开关与全局默认文本模型。 */
  function renderEngineSettings(view) {
    const engineStatus = createSaveStatus();
    const copilotSwitch = aiUi.switchControl({ label: COPILOT_SWITCH_LABEL, checked: view.copilotEnabled });
    const engineField = aiUi.field({
      description: '关闭后，Copilot 的模型不再出现在文本模型选择列表中；千问AI平台的文本模型在其设置页中启用。',
      control: copilotSwitch
    });
    copilotSwitch.onChange(async (checked) => {
      engineField.setError('');
      copilotSwitch.setDisabled(true);
      engineStatus.show(SAVING_TEXT, false);
      try {
        await window.hostBridge.request(REQUEST_UPDATE, { copilotEnabled: checked });
      } catch (error) {
        copilotSwitch.setValue(!checked);
        copilotSwitch.setDisabled(false);
        const message = fieldErrorOf(error, 'copilotEnabled');
        if (message) {
          engineField.setError(message);
          engineStatus.show('', false);
        } else {
          engineStatus.show(`保存失败：${errorText(error)}`, true);
        }
        return;
      }
      // 开关会改变可选的文本模型列表，重新读取后整页刷新。
      await reloadPage();
    });

    const elements = [engineField.element, engineStatus.element];
    if (view.choices.length > 0) {
      const modelStatus = createSaveStatus();
      const modelSelect = aiUi.select({
        options: view.choices.map((choice) => ({ value: choice.key, label: choice.label })),
        value: view.defaultModel,
        allowEmpty: false,
        ariaLabel: '默认文本模型',
        onChange: (value) => void saveSetting({ defaultModel: value }, modelStatus)
      });
      const modelField = aiUi.field({
        label: '默认文本模型',
        description: '生成创意、剧本、分镜脚本和资产提示词时使用；作品可以在“编辑作品”中单独选择，不选则沿用这里。',
        control: modelSelect
      });
      elements.push(modelField.element);
      if (view.modelNote) elements.push(aiUi.h('p', { class: 'status-warning settings-note', text: view.modelNote }));
      elements.push(modelStatus.element);
    }
    if (view.engineNote) elements.push(aiUi.h('p', { class: 'status-warning settings-note', text: view.engineNote }));
    return elements;
  }

  /** 文本生成设置区：先设置文本模型，再设置对所有文本模型通用的小说分段。 */
  function renderTextSettings(view) {
    const splitStatus = createSaveStatus();
    const splitRadio = aiUi.radioGroup({
      options: SPLIT_MODE_OPTIONS,
      value: view.splitMode,
      direction: 'horizontal',
      ariaLabel: '小说分段方式',
      onChange: (value) => {
        updateCharsDescription(value);
        void saveSetting({ splitMode: value }, splitStatus);
      }
    });
    const splitField = aiUi.field({
      label: '小说分段方式',
      description: '按章节时识别不到章节标题，会自动改为按字数。',
      control: splitRadio
    });

    const { min, max } = view.segmentCharsRange;
    const charsStatus = createSaveStatus();
    const charsInput = aiUi.textInput({ value: String(view.maxSegmentChars), ariaLabel: '每段字数上限' });
    const charsField = aiUi.field({
      label: '每段字数上限',
      description: charsDescription(view.splitMode),
      control: charsInput
    });
    /** 说明文字随分段方式切换：两种方式下这个值都会用，作用不同。 */
    function charsDescription(mode) {
      const effect = mode === 'chapter' ? '按章节时，单章超过此值会在段落处再切分。' : '按字数时，每段按此字数切分。';
      return `${min} 至 ${max} 的整数；${effect}`;
    }
    function updateCharsDescription(mode) {
      charsField.element.querySelector('.ui-field__description').textContent = charsDescription(mode);
    }
    // 输入框失去焦点且内容有变化时才保存；格式不对时不请求宿主，直接在字段下方提示。
    let savedChars = String(view.maxSegmentChars);
    charsInput.focusTarget.addEventListener('change', () => {
      const text = charsInput.getValue().trim();
      if (text === savedChars) return;
      const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
      if (!Number.isInteger(value) || value < min || value > max) {
        charsField.setError(`必须是 ${min} 到 ${max} 之间的整数。`);
        charsStatus.show('', false);
        return;
      }
      charsField.setError('');
      savedChars = text;
      void saveSetting({ maxSegmentChars: value }, charsStatus);
    });

    return aiUi.h(
      'section',
      { class: 'settings-section' },
      aiUi.h('h2', { text: '文本生成' }),
      renderEngineSettings(view),
      aiUi.h('h3', { class: 'settings-subtitle', text: '小说分段（所有文本模型通用）' }),
      splitField.element,
      splitStatus.element,
      charsField.element,
      charsStatus.element
    );
  }

  /**
   * 让开关的无障碍名称带上所属对象：表格行里的“启用”开关文字相同，读屏时无法区分。
   * @param {object} control 开关控件。
   * @param {string} name 无障碍名称。
   */
  function nameSwitch(control, name) {
    control.focusTarget.removeAttribute('aria-labelledby');
    control.focusTarget.setAttribute('aria-label', name);
  }

  /** 访问密钥区：输入框、保存与清除按钮、配置状态；保存后在原位更新，不重绘整个分区。 */
  function renderApiKey(provider) {
    let configured = provider.apiKeyConfigured;
    const status = createSaveStatus();
    const keyState = aiUi.h('span', { class: 'provider-key-state' });
    const keyInput = aiUi.textInput({ type: 'password', ariaLabel: `${provider.displayName}访问密钥`, onEnter: () => void saveKey() });
    const keyField = aiUi.field({
      label: '访问密钥',
      description: '密钥保存在 VS Code 的密钥存储中，不会写入数据库，也不会在页面上显示。',
      control: keyInput
    });
    const saveButton = aiUi.button({ text: '保存密钥', variant: 'primary', onClick: () => void saveKey() });
    const clearButton = aiUi.button({ text: '清除密钥', variant: 'danger', onClick: () => void clearKey() });
    const testButton = aiUi.button({ text: '测试连接', onClick: () => void testConnection() });

    /** 按是否已配置刷新状态文字、占位文字和按钮。 */
    function refresh() {
      keyState.textContent = configured ? KEY_CONFIGURED_TEXT : KEY_MISSING_TEXT;
      keyState.className = `provider-key-state ${configured ? 'status-success' : 'status-warning'}`;
      keyInput.focusTarget.placeholder = configured ? KEY_PLACEHOLDER_REPLACE : KEY_PLACEHOLDER_NEW;
      saveButton.setText(configured ? '更换密钥' : '保存密钥');
      clearButton.element.hidden = !configured;
      testButton.setDisabled(!configured);
    }

    /** 用已保存的密钥和设置测试连接，结果显示在状态文字里。 */
    async function testConnection() {
      testButton.setDisabled(true);
      status.show(TESTING_TEXT, false);
      try {
        const result = await window.hostBridge.request(REQUEST_PROVIDER_TEST_CONNECTION, { providerId: provider.id });
        status.show(result.message, !result.ok);
      } catch (error) {
        status.show(`测试失败：${errorText(error)}`, true);
      } finally {
        testButton.setDisabled(!configured);
      }
    }

    async function saveKey() {
      const apiKey = keyInput.getValue().trim();
      if (apiKey === '') {
        keyField.setError('访问密钥不能为空。');
        return;
      }
      keyField.setError('');
      saveButton.setDisabled(true);
      status.show(SAVING_TEXT, false);
      try {
        const result = await window.hostBridge.request(REQUEST_PROVIDER_SET_KEY, { providerId: provider.id, apiKey });
        keyInput.setValue('');
        configured = result.provider.apiKeyConfigured;
        refresh();
        status.show(SAVED_TEXT, false);
      } catch (error) {
        const message = fieldErrorOf(error, API_KEY_FIELD);
        if (message) {
          keyField.setError(message);
          status.show('', false);
        } else {
          status.show(`保存失败：${errorText(error)}`, true);
        }
      } finally {
        saveButton.setDisabled(false);
      }
    }

    async function clearKey() {
      const confirmed = await aiUi.confirm({
        title: '清除访问密钥',
        message: `清除后将无法使用“${provider.displayName}”的模型，需要重新填写密钥。`,
        confirmText: '清除',
        cancelText: '取消',
        variant: 'danger'
      });
      if (!confirmed) return;
      clearButton.setDisabled(true);
      status.show(SAVING_TEXT, false);
      try {
        const result = await window.hostBridge.request(REQUEST_PROVIDER_CLEAR_KEY, { providerId: provider.id });
        configured = result.provider.apiKeyConfigured;
        refresh();
        status.show(SAVED_TEXT, false);
      } catch (error) {
        status.show(`清除失败：${errorText(error)}`, true);
      } finally {
        clearButton.setDisabled(false);
      }
    }

    refresh();
    return aiUi.h(
      'div',
      { class: 'provider-key' },
      keyField.element,
      aiUi.h('div', { class: 'provider-key-actions' }, saveButton.element, testButton.element, clearButton.element, keyState),
      status.element
    );
  }

  /** 服务商的一个设置项：下拉选择后立即保存，文本在失去焦点且有变化时保存；校验错误显示在字段下方。 */
  function renderProviderSetting(provider, setting) {
    const status = createSaveStatus();
    let saved = setting.value;
    let field;

    async function save(value) {
      status.show(SAVING_TEXT, false);
      try {
        const result = await window.hostBridge.request(REQUEST_PROVIDER_UPDATE, { providerId: provider.id, settings: { [setting.key]: value } });
        const current = result.provider.settings.find((item) => item.key === setting.key);
        saved = current ? current.value : value;
        field.setError('');
        status.show(SAVED_TEXT, false);
        return saved;
      } catch (error) {
        const message = fieldErrorOf(error, setting.key);
        if (message) {
          field.setError(message);
          status.show('', false);
        } else {
          status.show(`保存失败：${errorText(error)}`, true);
        }
        return null;
      }
    }

    let control;
    if (setting.control === 'select') {
      control = aiUi.select({
        options: setting.options.map((option) => ({ value: option.value, label: option.label })),
        value: setting.value,
        allowEmpty: false,
        ariaLabel: setting.label,
        onChange: (value) => void save(value)
      });
    } else {
      control = aiUi.textInput({ value: setting.value, ariaLabel: setting.label });
      control.focusTarget.addEventListener('change', () => {
        const text = control.getValue().trim();
        if (text === saved) {
          field.setError('');
          return;
        }
        void save(text).then((normalized) => {
          if (normalized !== null) control.setValue(normalized);
        });
      });
    }
    field = aiUi.field({ label: setting.label, description: setting.description, control });
    return aiUi.h('div', { class: 'provider-setting' }, field.element, status.element);
  }

  /** 服务商的模型表：名称与代码、类型、启用开关、能力摘要。 */
  function renderModelTable(provider, status) {
    const columns = [
      { title: '模型', minWidth: 180, render: (model) => aiUi.tableMainCell({ text: model.displayName, description: model.code }) },
      { title: '类型', width: 72, nowrap: true, render: (model) => aiUi.chip({ text: model.kindLabel }) },
      {
        title: '启用',
        width: 120,
        nowrap: true,
        render: (model) => {
          const control = aiUi.switchControl({ label: '启用', checked: model.isEnabled });
          nameSwitch(control, `启用模型 ${model.displayName}`);
          control.onChange(async (checked) => {
            status.show(SAVING_TEXT, false);
            try {
              await window.hostBridge.request(REQUEST_MODEL_SET_ENABLED, { modelId: model.id, isEnabled: checked });
              status.show(SAVED_TEXT, false);
            } catch (error) {
              control.setValue(!checked);
              status.show(`保存失败：${errorText(error)}`, true);
            }
          });
          return control.element;
        }
      },
      {
        title: '能力',
        minWidth: 220,
        render: (model) => aiUi.h('div', { class: 'provider-capability' }, model.capabilitySummary.map((line) => aiUi.h('div', { text: line })))
      }
    ];
    return aiUi.table({ columns, rows: provider.models, ariaLabel: `${provider.displayName}的模型` }).element;
  }

  /** 一个服务商的设置区：标题与启用开关、访问密钥、设置项、模型表。 */
  function renderProvider(provider) {
    const status = createSaveStatus();
    const enabledSwitch = aiUi.switchControl({ label: '启用', checked: provider.isEnabled });
    nameSwitch(enabledSwitch, `启用服务商 ${provider.displayName}`);
    enabledSwitch.onChange(async (checked) => {
      status.show(SAVING_TEXT, false);
      try {
        await window.hostBridge.request(REQUEST_PROVIDER_UPDATE, { providerId: provider.id, isEnabled: checked });
        status.show(SAVED_TEXT, false);
      } catch (error) {
        enabledSwitch.setValue(!checked);
        status.show(`保存失败：${errorText(error)}`, true);
      }
    });

    return aiUi.h(
      'section',
      { class: 'settings-section settings-section--wide' },
      aiUi.h('div', { class: 'provider-header' }, aiUi.h('h2', { text: provider.displayName }), enabledSwitch.element),
      status.element,
      renderApiKey(provider),
      provider.settings.map((setting) => renderProviderSetting(provider, setting)),
      aiUi.h('h3', { class: 'provider-models-title', text: '模型' }),
      provider.models.length === 0 ? aiUi.h('p', { class: 'description', text: '该服务商没有提供模型。' }) : renderModelTable(provider, status)
    );
  }

  /** 服务商列表中的状态文字：已启用/已停用、密钥是否已配置。 */
  function renderProviderStatus(provider) {
    return aiUi.h(
      'div',
      { class: 'provider-status' },
      aiUi.h('span', { class: provider.isEnabled ? 'status-success' : 'description', text: provider.isEnabled ? '已启用' : '已停用' }),
      aiUi.h('span', { class: provider.apiKeyConfigured ? 'status-success' : 'status-warning', text: provider.apiKeyConfigured ? '密钥已配置' : '密钥未配置' })
    );
  }

  /** 服务商列表：每个服务商一行，点“设置”进入它的详情。 */
  function renderProviderList(providers) {
    if (providers.length === 0) {
      return aiUi.h(
        'section',
        { class: 'settings-section' },
        aiUi.h('h2', { text: '模型服务商' }),
        aiUi.h('p', { class: 'description', text: '尚未接入模型。' })
      );
    }
    const columns = [
      { title: '服务商', minWidth: 160, render: (provider) => aiUi.tableMainCell({ text: provider.displayName, description: provider.code || '' }) },
      {
        title: '模型类型',
        width: 160,
        render: (provider) => aiUi.h('div', { class: 'provider-chips' }, [...new Set(provider.models.map((model) => model.kindLabel))].map((text) => aiUi.chip({ text })))
      },
      { title: '状态', width: 180, render: renderProviderStatus },
      {
        title: '模型',
        width: 110,
        nowrap: true,
        render: (provider) => `启用 ${provider.models.filter((model) => model.isEnabled).length} / ${provider.models.length}`
      },
      {
        title: '操作',
        type: 'actions',
        render: (provider) => aiUi.button({ text: '设置', compact: true, ariaLabel: `设置：${provider.displayName}`, onClick: () => openProvider(provider.id) }).element
      }
    ];
    return aiUi.h(
      'section',
      { class: 'settings-section settings-section--wide' },
      aiUi.h('h2', { text: '模型服务商' }),
      aiUi.table({ columns, rows: providers, ariaLabel: '模型服务商' }).element
    );
  }

  /** 当前加载的设置数据；尚未加载成功时为 null。 */
  let data = null;

  /** 重新读取设置并渲染整页；失败时在页面顶部显示原因。 */
  async function reloadPage() {
    try {
      data = await window.hostBridge.request(REQUEST_LOAD);
      renderPage();
    } catch (error) {
      root.prepend(aiUi.h('p', { class: 'status-error', text: errorText(error) }));
    }
  }

  /** 渲染页面：文本生成设置与服务商列表。 */
  function renderPage() {
    root.textContent = '';
    root.append(renderTextSettings(data.text), renderProviderList(data.providers));
  }

  /** 弹出服务商的设置页；关闭后重新读取，让列表里的启用、密钥、模型数量等状态是最新的（读取失败时沿用之前的数据）。 */
  function openProvider(providerId) {
    const provider = data.providers.find((item) => item.id === providerId);
    if (!provider) return;
    const page = aiUi.openPage({
      title: `${provider.displayName}设置`,
      content: renderProvider(provider),
      width: 900,
      height: 640,
      minWidth: 480,
      minHeight: 320,
      buttons: [{ id: 'close', text: '关闭', isCancel: true }]
    });
    void page.closed.then(async () => {
      try {
        data = await window.hostBridge.request(REQUEST_LOAD);
      } catch {
        // 沿用旧数据，列表状态可能稍有滞后。
      }
      renderPage();
    });
  }

  /** 加载设置并渲染页面；失败时显示原因和“重试”。 */
  async function load() {
    root.textContent = '';
    root.append(aiUi.h('p', { class: 'description', text: '加载中…' }));
    try {
      data = await window.hostBridge.request(REQUEST_LOAD);
      renderPage();
    } catch (error) {
      root.textContent = '';
      root.append(
        aiUi.h('p', { class: 'status-error', text: errorText(error) }),
        aiUi.button({ text: '重试', onClick: () => void load() }).element
      );
    }
  }

  void load();
})();
