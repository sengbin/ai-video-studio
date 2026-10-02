// ------------------------------------------------------------------------
// 名称：profile.js
// 说明：生成参数（F8）：按“本集 → 作品 → 项目默认”算出生效的模型、画幅、分辨率与声音模式，并检查是否落在所选模型的能力范围内；提供检查器“参数”页签的内容，编辑作品默认与本集覆盖。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不发请求，保存由 workbench.js 注入；必须先于 workbench.js 加载；对外是 window.aiProfile 的 resolve、resolveForGroup、summarize、create。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const PREFERRED_RESOLUTION = '720P';
  const AUDIO_MODE_LABELS = { native: '模型生成声音', none: '无声' };
  const SOURCE_LABELS = { group: '本组覆盖', episode: '本集覆盖', work: '作品默认', project: '项目默认', default: '未设置，使用默认值', none: '未设置' };
  const SCOPE_OPTIONS = [
    { value: 'work', label: '本作品默认（所有集）' },
    { value: 'episode', label: '仅本集' },
    { value: 'group', label: '仅选中的镜头组' }
  ];
  const SCOPE_HINTS = {
    work: '作品默认适用于这个作品的所有集；某一集需要不同取值时，在“仅本集”里覆盖。',
    episode: '本集覆盖只对当前这一集生效，留空表示沿用作品默认。',
    group: '本组覆盖只对左栏选中的镜头组生效，留空表示沿用本集、作品或项目默认。'
  };
  const EMPTY_OPTION_TEXT = '沿用上一级';

  /** 当前的参数面板；只有一个。 */
  let panel = null;

  /** 在选项里找与值相同的一项（忽略大小写，兼容旧版本保存的小写分辨率），返回选项里的写法；没有则返回 undefined。 */
  function matchOption(options, value) {
    const text = String(value).toLowerCase();
    return options.find((option) => String(option).toLowerCase() === text);
  }

  /** 在模型支持的值里选一个：当前值有效就用当前值，否则用偏好值或第一个。 */
  function pickDefault(values, preferred) {
    return preferred && values.includes(preferred) ? preferred : values[0] || '';
  }

  /**
   * 算出生效参数：已设置的值原样使用（超出所选模型范围时记入 issues），没有设置的用模型的默认值。
   * @param {{ models: object[] }} catalog 工作台清单，models 为可用的视频模型。
   * @param {{ effective: object }} profile 一集的参数视图。
   * @returns {{ model: object|undefined, values: object, sources: object, issues: object }}
   */
  function resolve(catalog, profile) {
    const stored = profile.effective.values;
    const sources = { ...profile.effective.sources };
    const issues = {};
    let model;
    if (stored.modelId !== null) {
      model = catalog.models.find((item) => item.id === stored.modelId);
      if (!model) issues.modelId = '所选模型不可用（已停用，或服务商未启用、未填写访问密钥）。';
    } else {
      model = catalog.models[0];
      sources.modelId = 'default';
    }
    const values = { modelId: model ? String(model.id) : '', aspectRatio: '', resolution: '', audioMode: '' };
    const settle = (field, options, preferred, label) => {
      if (!model || options.length === 0) {
        sources[field] = 'none';
        return;
      }
      if (stored[field] !== null) {
        const matched = matchOption(options, stored[field]);
        values[field] = matched === undefined ? stored[field] : matched;
        if (matched === undefined) issues[field] = `${label}“${AUDIO_MODE_LABELS[stored[field]] || stored[field]}”超出所选模型范围，请重新选择。`;
        return;
      }
      values[field] = pickDefault(options, preferred);
      sources[field] = 'default';
    };
    settle('aspectRatio', model ? model.aspectRatios : [], '', '画幅');
    settle('resolution', model ? model.resolutions : [], PREFERRED_RESOLUTION, '分辨率');
    settle('audioMode', model ? model.audioModes : [], 'native', '声音模式');
    return { model, values, sources, issues };
  }

  /**
   * 算出一个镜头组的生效参数：本组覆盖里不为空的字段优先于本集的生效值，其余同 resolve。
   * @param {{ models: object[] }} catalog 工作台清单。
   * @param {{ effective: object }} profile 一集的参数视图。
   * @param {{ modelId: number|null, aspectRatio: string|null, resolution: string|null, audioMode: string|null }} overrides 这个镜头组的覆盖。
   */
  function resolveForGroup(catalog, profile, overrides) {
    const values = { ...profile.effective.values };
    const sources = { ...profile.effective.sources };
    for (const field of Object.keys(values)) {
      if (overrides[field] !== null && overrides[field] !== undefined) {
        values[field] = overrides[field];
        sources[field] = 'group';
      }
    }
    return resolve(catalog, { effective: { values, sources } });
  }

  /** 参数的一行摘要，用于工具栏。 */
  function summarize(resolved) {
    if (!resolved.model) return '未选择视频模型';
    const { values } = resolved;
    return [resolved.model.displayName, values.aspectRatio, values.resolution, values.audioMode ? AUDIO_MODE_LABELS[values.audioMode] || values.audioMode : '']
      .filter(Boolean)
      .join(' · ');
  }

  /** 字段说明：当前生效的值与来源。 */
  function describeEffective(field, resolved) {
    const value = resolved.values[field];
    if (value === '') return resolved.model ? '这个模型没有此参数。' : '';
    let text = value;
    if (field === 'modelId') text = resolved.model.displayName;
    if (field === 'audioMode') text = AUDIO_MODE_LABELS[value] || value;
    return `当前生效：${text}（${SOURCE_LABELS[resolved.sources[field]]}）`;
  }

  /** 某一级已保存的值对应的下拉值；未设置为空串。 */
  function storedValue(values, field) {
    return values[field] === null ? '' : String(values[field]);
  }

  /** 下拉选项：加上已保存但不在选项中的值（标注原因），避免界面悄悄丢掉它。 */
  function withStoredOption(options, value, note) {
    return value === '' || options.some((option) => option.value === value) ? options : [...options, { value, label: `${value}${note}` }];
  }

  /** 重新渲染面板里的字段；还没有加载到集的参数时只显示提示。 */
  function renderFields() {
    const { host, fieldsElement, scopeControl } = panel;
    const { catalog, profile, group } = host.getState();
    fieldsElement.textContent = '';
    if (!catalog || !profile) {
      panel.hintElement.textContent = '请先选择一个有分镜脚本的集。';
      return;
    }
    const scope = scopeControl.getValue();
    if (scope === 'group' && !group) {
      panel.hintElement.textContent = '请先在左栏选择一个镜头组。';
      return;
    }
    const resolved = scope === 'group' ? resolveForGroup(catalog, profile, group.overrides) : resolve(catalog, profile);
    const values = scope === 'work' ? profile.work : scope === 'episode' ? profile.episode : group.overrides;
    panel.hintElement.textContent = scope === 'group' ? `第 ${group.seq} 组：${SCOPE_HINTS.group}` : SCOPE_HINTS[scope];

    const addField = (field, label, options, note) => {
      const stored = storedValue(values, field);
      const matched = stored === '' ? undefined : options.find((option) => option.value.toLowerCase() === stored.toLowerCase());
      const current = matched === undefined ? stored : matched.value;
      const select = aiUi.select({
        options: withStoredOption(options, current, note),
        value: current,
        allowEmpty: true,
        placeholder: EMPTY_OPTION_TEXT,
        ariaLabel: label,
        onChange: (value) => void change(field, value)
      });
      const wrapper = aiUi.field({ label, description: describeEffective(field, resolved), control: select });
      if (resolved.issues[field]) wrapper.setError(resolved.issues[field]);
      fieldsElement.append(wrapper.element);
    };

    addField(
      'modelId',
      '视频模型',
      catalog.models.map((model) => ({ value: String(model.id), label: `${model.displayName}（${model.providerName}）` })),
      '（不可用）'
    );
    const model = resolved.model;
    if (!model) return;
    if (model.aspectRatios.length > 0) addField('aspectRatio', '画幅', model.aspectRatios.map((value) => ({ value, label: value })), '（超出所选模型范围）');
    if (model.resolutions.length > 0) addField('resolution', '分辨率', model.resolutions.map((value) => ({ value, label: value })), '（超出所选模型范围）');
    if (model.audioModes.length > 0) {
      addField('audioMode', '声音', model.audioModes.map((mode) => ({ value: mode, label: AUDIO_MODE_LABELS[mode] || mode })), '（超出所选模型范围）');
    }
  }

  /** 修改一个字段并保存；空串表示恢复继承。 */
  async function change(field, value) {
    if (!panel) return;
    const current = panel;
    const payload = value === '' ? null : field === 'modelId' ? Number(value) : value;
    const result = await current.host.save(current.scopeControl.getValue(), { [field]: payload });
    if (panel !== current) return;
    current.messageElement.textContent = result.ok ? '已保存' : `保存失败：${result.message}`;
    current.messageElement.className = result.ok ? 'wb-message status-success' : 'wb-message status-error';
    current.messageElement.hidden = false;
    renderFields();
  }

  /**
参数页签）：编辑作品默认与本集覆盖，选择后即时保存。只创建一个实例。
   * @param {{ getState: () => { catalog: object|null, profile: object|null },“参数”页签）：编辑作品默认与本集覆盖，选择后即时保存。只创建一个实例。
   * @param {{ getState: () => { catalog: object|null, profile: object|null }, save: (scope: string, changes: object) => Promise<{ ok: boolean, message?: string }> }} host 宿主页面提供的状态与保存函数。
   * @returns {{ element: HTMLElement, refresh: () => void, setScope: (scope: string) => void }}
   */
  function create(host) {
    const scopeControl = aiUi.radioGroup({ options: SCOPE_OPTIONS, value: 'work', direction: 'vertical', ariaLabel: '参数范围', onChange: () => renderFields() });
    const hintElement = aiUi.h('p', { class: 'description' });
    const messageElement = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    const fieldsElement = aiUi.h('div', { class: 'wb-profile__fields' });
    const element = aiUi.h('div', { class: 'wb-profile' }, scopeControl.element, hintElement, messageElement, fieldsElement);
    panel = { host, scopeControl, hintElement, messageElement, fieldsElement, key: '' };
    renderFields();
    return { element, refresh, setScope };
  }

  /** 切换编辑范围（如从镜头组详情跳到“仅选中的镜头组”）。 */
  function setScope(scope) {
    if (!panel) return;
    panel.scopeControl.setValue(scope);
    renderFields();
  }

  /** 页面数据变化后刷新面板；内容没有变化时不重绘，避免打断正在打开的下拉。 */
  function refresh() {
    if (!panel) return;
    const { catalog, profile, group } = panel.host.getState();
    const key = JSON.stringify([catalog && catalog.models, profile, group]);
    if (key === panel.key) return;
    panel.key = key;
    renderFields();
  }

  window.aiProfile = { resolve, resolveForGroup, summarize, create };
})();
