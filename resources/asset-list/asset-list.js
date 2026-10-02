// ------------------------------------------------------------------------
// 名称：asset-list.js
// 说明：资产列表页脚本：列出某种资产类型下所有项目的资产，按项目与名称关键字筛选，在页内弹出页面中新建、编辑资产，带使用情况提示地删除资产。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求与事件名称与 src/app/pages/asset-list-handlers.ts、src/app/forms/asset-form.ts 一致；依赖 form/form-runtime.js（aiForm）与 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'assets.load';
  const REQUEST_TAKE_PENDING = 'assets.takePending';
  const REQUEST_PREPARE_DELETE = 'assets.prepareDelete';
  const REQUEST_DELETE = 'assets.delete';
  const EVENT_CHANGED = 'assets.changed';
  const EVENT_ACTION = 'assets.action';
  const ACTION_CREATE = 'create';
  const FORM_CREATE = 'asset.create';
  const FORM_EDIT = 'asset.edit';
  const KIND_AUDIO = 'audio';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const FILTER_ALL = 'all';
  const REFRESH_DELAY_MS = 150;
  const MAX_USAGE_LINES = 8;
  const KIND_LABELS = { character: '角色', scene: '场景', prop: '道具', effect: '特效', audio: '音频' };
  const AUDIO_KIND_LABELS = { voice: '音色参考', music: '背景音乐', sfx: '音效' };

  const { formatRelativeTime } = window.pageFormat;

  const root = document.getElementById('app');
  /** 页面绑定的资产类型，首次加载成功后由宿主告知。 */
  let kind = '';
  let projects = [];
  let assets = [];
  let loadError = '';
  let isLoading = true;
  let isFormOpen = false;
  let filterProjectId = FILTER_ALL;
  let keyword = '';
  let refreshTimer = 0;
  /** 项目下拉当前对应的项目清单标记，清单变化时才重建下拉；为 null 表示还没有渲染过。 */
  let projectOptionsKey = null;
  let projectSlot = null;
  let contentElement = null;
  let messageElement = null;

  /** 在操作结果区显示文字；空串表示清除。 */
  function showMessage(text, isError) {
    messageElement.textContent = text;
    messageElement.className = isError ? 'assets-message status-error' : 'assets-message status-success';
    messageElement.hidden = text === '';
  }

  /** 发起请求，失败时在操作结果区显示原因；成功返回响应数据，失败返回 undefined。 */
  async function runAction(name, payload) {
    showMessage('', false);
    try {
      return await window.hostBridge.request(name, payload);
    } catch (error) {
      showMessage((error && error.message) || GENERIC_ERROR_TEXT, true);
      return undefined;
    }
  }

  /** 项目下拉：全部项目加各个项目；项目被删除时回到“全部项目”。 */
  function renderProjectFilter() {
    const key = projects.map((project) => `${project.id}:${project.name}`).join('|');
    if (!projects.some((project) => String(project.id) === filterProjectId)) filterProjectId = FILTER_ALL;
    if (key === projectOptionsKey) return;
    projectOptionsKey = key;
    const select = aiUi.select({
      options: [{ value: FILTER_ALL, label: '全部项目' }, ...projects.map((project) => ({ value: String(project.id), label: project.name }))],
      value: filterProjectId,
      allowEmpty: false,
      ariaLabel: '按项目筛选',
      onChange: (value) => {
        filterProjectId = value;
        renderContent();
      }
    });
    projectSlot.textContent = '';
    projectSlot.append(select.element);
  }

  /** 加载资产并刷新界面；showLoading 为 false 时保留现有内容（后台刷新）。 */
  async function loadAssets(showLoading) {
    if (showLoading) {
      isLoading = true;
      renderContent();
    }
    loadError = '';
    try {
      const data = await window.hostBridge.request(REQUEST_LOAD);
      kind = data.kind;
      projects = data.projects;
      assets = data.assets;
    } catch (error) {
      loadError = (error && error.message) || '资产加载失败。';
    }
    isLoading = false;
    renderProjectFilter();
    renderContent();
  }

  /** 数据变化后稍作合并再刷新。 */
  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadAssets(false), REFRESH_DELAY_MS);
  }

  /** 弹出表单；已有表单打开时忽略，避免重复点击叠出多个。 */
  async function showForm(options) {
    if (isFormOpen) return;
    isFormOpen = true;
    try {
      await aiForm.open(options);
    } finally {
      isFormOpen = false;
    }
  }

  /** 弹出“新建资产”表单；筛选了某个项目时把它作为所属项目的默认值。 */
  function openCreateForm() {
    const params = { kind };
    if (filterProjectId !== FILTER_ALL) params.projectId = Number(filterProjectId);
    void showForm({ form: FORM_CREATE, params });
  }

  /** 弹出“编辑资产”表单。 */
  function openEditForm(asset) {
    void showForm({ form: FORM_EDIT, params: { assetId: asset.id } });
  }

  /** 删除资产：先取使用情况，再用页内对话框确认，最后请求删除。 */
  async function deleteAsset(asset) {
    const impact = await runAction(REQUEST_PREPARE_DELETE, { id: asset.id });
    if (!impact) return;

    const details = impact.usage.bindings
      .slice(0, MAX_USAGE_LINES)
      .map((use) => `${use.workName} › 第 ${use.episodeSeq} 集 ${use.episodeTitle}：${use.entityName}`);
    if (impact.usage.bindings.length > MAX_USAGE_LINES) details.push(`……另有 ${impact.usage.bindings.length - MAX_USAGE_LINES} 处`);
    if (impact.usage.soundReferences > 0) details.push(`${impact.usage.soundReferences} 条镜头声音指定了该音频`);
    const used = details.length > 0;
    const confirmed = await aiUi.confirm({
      title: `删除${KIND_LABELS[kind]}`,
      message: used
        ? `“${impact.name}”正在被以下位置使用，删除后会连同它的文件和绑定一并清除，且无法恢复：`
        : `将删除“${impact.name}”及其文件，且无法恢复。`,
      details,
      confirmText: '删除',
      variant: 'danger'
    });
    if (!confirmed) return;

    const result = await runAction(REQUEST_DELETE, { id: asset.id });
    if (result) showMessage(`已删除“${result.name}”。`, false);
  }

  /** 处理宿主带来的请求：弹出“新建资产”表单；页面还没加载完时先等一次加载，才知道类型。 */
  async function handleRequest(request) {
    if (!request || request.action !== ACTION_CREATE) return;
    if (!kind) await initialLoad;
    if (kind) openCreateForm();
  }

  /** 音频时长的显示文字。 */
  function formatDuration(seconds) {
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  }

  /** 预览单元格：图片类显示缩略图，音频显示类型与时长。 */
  function renderPreview(asset) {
    if (asset.kind === KIND_AUDIO) {
      const audioKind = AUDIO_KIND_LABELS[asset.attributes.audio_kind] || '音频';
      return aiUi.h(
        'div',
        { class: 'asset-audio' },
        aiUi.chip({ text: audioKind }),
        asset.durationSeconds === null ? null : aiUi.h('span', { class: 'description', text: formatDuration(asset.durationSeconds) })
      );
    }
    if (!asset.thumbnail) return aiUi.h('div', { class: 'asset-thumb asset-thumb--empty', text: '无图' });
    return aiUi.h(
      'div',
      { class: 'asset-thumb' },
      aiUi.h('img', {
        class: 'asset-thumb__image',
        attrs: { src: `data:${asset.thumbnail.mime};base64,${asset.thumbnail.data}`, alt: asset.name }
      })
    );
  }

  /** 名称下方的简要说明：图像类取视角与风格，音频取描述。 */
  function describeAsset(asset) {
    if (asset.kind === KIND_AUDIO) return asset.attributes.description || '';
    return [asset.composition, asset.style].filter(Boolean).join(' · ');
  }

  /** 资产表格的列。 */
  const ASSET_COLUMNS = [
    { title: '预览', width: 96, minWidth: 80, render: (asset) => renderPreview(asset) },
    {
      title: '名称',
      width: '30%',
      minWidth: 160,
      render: (asset) => aiUi.tableMainCell({ text: asset.name, description: describeAsset(asset) })
    },
    { title: '所属项目', width: '18%', minWidth: 120, render: (asset) => aiUi.chip({ text: asset.projectName }) },
    {
      title: '参考文件',
      width: 80,
      nowrap: true,
      muted: (asset) => asset.fileCount === 0,
      render: (asset) => String(asset.fileCount)
    },
    {
      title: '使用',
      width: 80,
      nowrap: true,
      muted: (asset) => asset.episodeCount === 0,
      render: (asset) => (asset.episodeCount === 0 ? '未使用' : `${asset.episodeCount} 集`)
    },
    {
      title: '更新时间',
      width: 110,
      nowrap: true,
      muted: true,
      render: (asset) => formatRelativeTime(asset.updatedAt),
      tooltip: (asset) => new Date(asset.updatedAt).toLocaleString('zh-CN')
    },
    {
      title: '操作',
      type: 'actions',
      render: (asset) => [
        aiUi.button({ kind: 'edit', compact: true, ariaLabel: `修改：${asset.name}`, onClick: () => openEditForm(asset) }).element,
        aiUi.button({ kind: 'delete', compact: true, ariaLabel: `删除：${asset.name}`, onClick: () => void deleteAsset(asset) }).element
      ]
    }
  ];

  /** 空状态和错误状态。 */
  function renderState(text, button) {
    return aiUi.h('div', { class: 'assets-state' }, aiUi.h('p', { class: 'description', text }), button && button.element);
  }

  /** 按当前状态刷新内容区：先按项目、再按名称关键字筛选。 */
  function renderContent() {
    contentElement.textContent = '';
    if (isLoading) {
      contentElement.append(renderState('加载中…'));
      return;
    }
    if (loadError) {
      contentElement.append(renderState(loadError, aiUi.button({ text: '重试', onClick: () => void loadAssets(true) })));
      return;
    }
    if (assets.length === 0) {
      contentElement.append(renderState(`还没有${KIND_LABELS[kind] || ''}资产。`, aiUi.button({ text: '新建', kind: 'add', onClick: openCreateForm })));
      return;
    }
    const text = keyword.trim().toLowerCase();
    const visible = assets.filter(
      (asset) => (filterProjectId === FILTER_ALL || String(asset.projectId) === filterProjectId) && asset.name.toLowerCase().includes(text)
    );
    contentElement.append(visible.length === 0 ? renderState('没有匹配的资产。') : aiUi.table({ columns: ASSET_COLUMNS, rows: visible, ariaLabel: '资产' }).element);
  }

  /** 渲染页面骨架：搜索框与项目筛选、操作结果、资产区。 */
  function renderPage() {
    const search = aiUi.textInput({
      type: 'search',
      placeholder: '搜索资产名称',
      ariaLabel: '搜索资产名称',
      onChange: (value) => {
        keyword = value;
        renderContent();
      }
    });
    projectSlot = aiUi.h('div', { class: 'assets-filter' });
    document.getElementById('page-toolbar').append(aiUi.h('div', { class: 'assets-search' }, search.element), projectSlot);

    messageElement = aiUi.h('p', { class: 'assets-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div');
    root.append(messageElement, contentElement);
    renderProjectFilter();
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, scheduleRefresh);
  window.hostBridge.onEvent(EVENT_ACTION, (request) => void handleRequest(request));
  const initialLoad = loadAssets(true);
  // 页面打开前已登记的请求（如侧栏点“添加”），加载完成后主动取走。
  void initialLoad
    .then(() => window.hostBridge.request(REQUEST_TAKE_PENDING))
    .then((result) => handleRequest(result && result.request))
    .catch(() => undefined);
})();
