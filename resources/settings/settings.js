// ------------------------------------------------------------------------
// 名称：settings.js
// 说明：模型设置页脚本：文本生成设置（Copilot 模型、小说分段方式、每段字数上限）即时保存，并说明图像、音频、视频模型尚未接入。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求名称与 src/app/pages/settings-handlers.ts 一致；每个字段旁显示“保存中…”“已保存”“保存失败”。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'settings.load';
  const REQUEST_UPDATE = 'settings.update';

  const AUTO_MODEL_LABEL = '自动';
  /** 下拉中“自动”选项的值：空串在下拉里表示“未选择”，所以用单独的值，保存时再转为空串。 */
  const AUTO_MODEL_VALUE = '__auto__';
  const SAVING_TEXT = '保存中…';
  const SAVED_TEXT = '已保存';
  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const SPLIT_MODE_OPTIONS = [
    { value: 'chapter', label: '按章节' },
    { value: 'length', label: '按字数' }
  ];

  const root = document.getElementById('app');

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

  /** 保存一项设置，并在状态文字中反馈结果。 */
  async function saveSetting(patch, status) {
    status.show(SAVING_TEXT, false);
    try {
      await window.hostBridge.request(REQUEST_UPDATE, patch);
      status.show(SAVED_TEXT, false);
    } catch (error) {
      status.show(`保存失败：${(error && error.message) || GENERIC_ERROR_TEXT}`, true);
    }
  }

  /** 模型下拉的选项：自动加可用模型；已保存但不可用的模型也保留，避免选中项凭空消失。 */
  function buildModelOptions(view) {
    const options = [{ value: AUTO_MODEL_VALUE, label: AUTO_MODEL_LABEL }, ...view.families.map((family) => ({ value: family, label: family }))];
    if (view.modelFamily !== '' && !view.families.includes(view.modelFamily)) {
      options.push({ value: view.modelFamily, label: `${view.modelFamily}（不可用）` });
    }
    return options;
  }

  /** 文本生成设置区。 */
  function renderTextSettings(view) {
    const modelStatus = createSaveStatus();
    const modelSelect = aiUi.select({
      options: buildModelOptions(view),
      value: view.modelFamily === '' ? AUTO_MODEL_VALUE : view.modelFamily,
      allowEmpty: false,
      ariaLabel: 'Copilot 模型',
      onChange: (value) => void saveSetting({ modelFamily: value === AUTO_MODEL_VALUE ? '' : value }, modelStatus)
    });
    const modelField = aiUi.field({
      label: 'Copilot 模型',
      description: '生成创意等文本时使用的模型；“自动”表示由 Copilot 选择可用模型。',
      control: modelSelect
    });

    const splitStatus = createSaveStatus();
    const splitRadio = aiUi.radioGroup({
      options: SPLIT_MODE_OPTIONS,
      value: view.splitMode,
      direction: 'horizontal',
      ariaLabel: '小说分段方式',
      onChange: (value) => void saveSetting({ splitMode: value }, splitStatus)
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
      description: `${min} 至 ${max} 的整数；按章节时，单章超过此值会在段落处再切分。`,
      control: charsInput
    });
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
      modelField.element,
      view.modelNote ? aiUi.h('p', { class: 'status-warning settings-note', text: view.modelNote }) : null,
      modelStatus.element,
      splitField.element,
      splitStatus.element,
      charsField.element,
      charsStatus.element
    );
  }

  /** 其他模型区：本阶段只有接口，没有接入具体模型。 */
  function renderOtherModels() {
    return aiUi.h(
      'section',
      { class: 'settings-section' },
      aiUi.h('h2', { text: '图像、音频、视频模型' }),
      aiUi.h('p', { class: 'description', text: '尚未接入模型。' })
    );
  }

  /** 加载设置并渲染页面；失败时显示原因和“重试”。 */
  async function load() {
    root.textContent = '';
    root.append(aiUi.h('p', { class: 'description', text: '加载中…' }));
    try {
      const view = await window.hostBridge.request(REQUEST_LOAD);
      root.textContent = '';
      root.append(renderTextSettings(view), renderOtherModels());
    } catch (error) {
      root.textContent = '';
      root.append(
        aiUi.h('p', { class: 'status-error', text: (error && error.message) || '设置加载失败。' }),
        aiUi.button({ text: '重试', onClick: () => void load() }).element
      );
    }
  }

  void load();
})();
