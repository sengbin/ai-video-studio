// ------------------------------------------------------------------------
// 名称：asset-list.js
// 说明：资产列表页脚本：列出某种资产类型的全部资产（资产不属于项目），按名称关键字和分类（全部、未分类、各分类）筛选，表格带分类列，工具栏的“分类管理”弹出分类管理页，在页内弹出页面中新建、编辑资产，显示提示词与图片（音频）生成状态，发起提示词生成、图片（音频）生成并打开版本层，带使用情况提示地删除资产。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求与事件名称与 src/app/pages/asset-list-handlers.ts、src/app/forms/asset-form.ts 一致；依赖 form/form-runtime.js（aiForm）、shared/page-format.js（pageFormat）、asset-list/asset-generate.js（aiAssetGenerate）、asset-list/asset-versions.js（aiAssetVersions）与 asset-list/asset-categories.js（aiAssetCategories）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'assets.load';
  const REQUEST_TAKE_PENDING = 'assets.takePending';
  const REQUEST_PREPARE_DELETE = 'assets.prepareDelete';
  const REQUEST_DELETE = 'assets.delete';
  const REQUEST_GENERATE_PROMPT = 'assets.generatePrompt';
  const REQUEST_CANCEL_PROMPT = 'assets.cancelPrompt';
  const REQUEST_REFERENCE_IMAGE = 'assets.referenceImage';
  const REQUEST_REFERENCE_AUDIO = 'assets.referenceAudio';
  const EVENT_CHANGED = 'assets.changed';
  const EVENT_ACTION = 'assets.action';
  const ACTION_CREATE = 'create';
  const FORM_CREATE = 'asset.create';
  const FORM_EDIT = 'asset.edit';
  const FORM_PROMPT = 'asset.prompt';
  const KIND_AUDIO = 'audio';
  /** 分类筛选的两个固定取值：全部、未分类；其余取值为分类标识的文本。 */
  const FILTER_ALL = 'all';
  const FILTER_NONE = 'none';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const REFRESH_DELAY_MS = 150;
  const MAX_USAGE_LINES = 8;
  const KIND_LABELS = { character: '角色', scene: '场景', prop: '道具', effect: '特效', audio: '音频' };
  const AUDIO_KIND_LABELS = { voice: '音色参考', music: '背景音乐', sfx: '音效' };

  const { formatRelativeTime } = window.pageFormat;

  const root = document.getElementById('app');
  /** 页面绑定的资产类型，首次加载成功后由宿主告知。 */
  let kind = '';
  let assets = [];
  /** 当前类型的分类（含资产数量），随资产一起加载。 */
  let categories = [];
  let loadError = '';
  let isLoading = true;
  let isFormOpen = false;
  let keyword = '';
  let categoryFilter = FILTER_ALL;
  /** 分类下拉当前对应的选项内容，没变化时不重建下拉。 */
  let categoryOptionsKey = '';
  let refreshTimer = 0;
  let contentElement = null;
  let messageElement = null;
  let categorySlot = null;
  let manageButton = null;

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
      assets = data.assets;
      categories = data.categories;
    } catch (error) {
      loadError = (error && error.message) || '资产加载失败。';
    }
    isLoading = false;
    // 当前筛选的分类已被删除时回到“全部”。
    if (categoryFilter !== FILTER_ALL && categoryFilter !== FILTER_NONE && !categories.some((category) => String(category.id) === categoryFilter)) {
      categoryFilter = FILTER_ALL;
    }
    renderCategoryFilter();
    manageButton.setDisabled(!kind);
    renderContent();
    // 分类管理页、版本层打开时跟着刷新（分类增删改、状态、缩略图、资产被删除）。
    window.aiAssetCategories.refresh(categories);
    void window.aiAssetVersions.refresh();
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

  /** 弹出“新建资产”表单。 */
  function openCreateForm() {
    void showForm({ form: FORM_CREATE, params: { kind } });
  }

  /** 弹出“编辑资产”表单。 */
  function openEditForm(asset) {
    void showForm({ form: FORM_EDIT, params: { assetId: asset.id } });
  }

  /** 弹出“提示词”表单：查看、手动修改或重新生成。 */
  function openPromptForm(asset) {
    void showForm({ form: FORM_PROMPT, params: { assetId: asset.id } });
  }

  /** 删除资产：先取使用情况，再用页内对话框确认，最后请求删除。 */
  async function deleteAsset(asset) {
    const impact = await runAction(REQUEST_PREPARE_DELETE, { id: asset.id });
    if (!impact) return;

    // 使用位置：集内实体绑定，加上镜头声音直接指定该音频的集（按集汇总条数）。
    const lines = [
      ...impact.usage.bindings.map((use) => `${use.workName} › 第 ${use.episodeSeq} 集 ${use.episodeTitle}：${use.entityName}`),
      ...impact.usage.soundEpisodes.map((use) => `${use.workName} › 第 ${use.episodeSeq} 集 ${use.episodeTitle}：${use.soundCount} 条镜头声音指定了该音频`)
    ];
    const details = lines.slice(0, MAX_USAGE_LINES);
    if (lines.length > MAX_USAGE_LINES) details.push(`……另有 ${lines.length - MAX_USAGE_LINES} 处`);
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

  /** 预览单元格：图片类显示缩略图，音频显示试听按钮（点击播放，播放时再点停止）、类型与时长。 */
  function renderPreview(asset) {
    if (asset.kind === KIND_AUDIO) {
      const audioKind = AUDIO_KIND_LABELS[asset.attributes.audio_kind] || '音频';
      const preview = aiUi.audioPreview({
        iconOnly: true,
        ariaLabel: `试听：${asset.name}`,
        load: () => runAction(REQUEST_REFERENCE_AUDIO, { id: asset.id })
      });
      return aiUi.h(
        'div',
        { class: 'asset-audio' },
        preview.element,
        aiUi.h(
          'div',
          { class: 'asset-audio__info' },
          aiUi.chip({ text: audioKind }),
          asset.durationSeconds === null ? null : aiUi.h('span', { class: 'description', text: formatDuration(asset.durationSeconds) })
        )
      );
    }
    if (!asset.thumbnail) return aiUi.h('div', { class: 'asset-thumb asset-thumb--empty', text: '无图' });
    return aiUi.h(
      'button',
      {
        class: 'asset-thumb asset-thumb--button',
        attrs: { type: 'button', 'aria-label': `查看原图：${asset.name}` },
        on: { click: () => void viewReferenceImage(asset) }
      },
      aiUi.h('img', {
        class: 'asset-thumb__image',
        attrs: { src: `data:${asset.thumbnail.mime};base64,${asset.thumbnail.data}`, alt: asset.name }
      })
    );
  }

  /** 点击预览缩略图：向宿主取第一张参考图的原图，弹出页查看。 */
  async function viewReferenceImage(asset) {
    const data = await runAction(REQUEST_REFERENCE_IMAGE, { id: asset.id });
    if (data) window.aiAssetVersions.viewImage(asset.name, data);
  }

  /** 名称下方的简要说明：图像类取视角与风格，音频取描述。 */
  function describeAsset(asset) {
    if (asset.kind === KIND_AUDIO) return asset.attributes.description || '';
    return [asset.composition, asset.style].filter(Boolean).join(' · ');
  }

  /** 提示词列：生成中、失败、已取消、未生成、已生成（可能需更新）。 */
  function renderPromptStatus(asset) {
    const hasPrompt = Boolean(asset.promptZh || asset.promptEn);
    if (asset.promptStatus === 'running') return aiUi.h('span', { class: 'description', text: '生成中…' });
    if (asset.promptStatus === 'failed') {
      return aiUi.h('span', { class: 'status-error', text: '失败', attrs: { title: asset.promptError || '' } });
    }
    if (asset.promptStatus === 'canceled') return aiUi.h('span', { class: 'description', text: '已取消' });
    if (!hasPrompt) return aiUi.h('span', { class: 'description', text: '未生成' });
    if (asset.isPromptOutdated) return aiUi.h('span', { class: 'status-warning', text: '已生成，需更新' });
    return aiUi.h('span', { class: 'status-success', text: '已生成' });
  }

  /** 图片（音频）列：未生成、生成中、失败、最新的成功版本，以及“有改动未生成”。 */
  function renderGenerationStatus(asset) {
    const { latest, latestSucceeded } = asset.generation;
    const parts = [];
    if (latest === null) {
      parts.push(aiUi.h('span', { class: 'description', text: '未生成' }));
    } else if (latest.status === 'queued' || latest.status === 'running') {
      parts.push(aiUi.h('span', { class: 'description', text: `v${latest.version} 生成中…` }));
    } else if (latest.status === 'failed') {
      parts.push(aiUi.h('span', { class: 'status-error', text: `v${latest.version} 失败`, attrs: { title: latest.errorMessage || '' } }));
    } else {
      parts.push(aiUi.h('span', { class: 'status-success', text: `v${latestSucceeded === null ? latest.version : latestSucceeded} 已生成` }));
    }
    if (asset.hasUngeneratedChanges) parts.push(aiUi.h('span', { class: 'status-warning', text: '有改动未生成' }));
    return aiUi.h('div', { class: 'asset-status' }, parts);
  }

  /** 当前采用列：采用的版本、手动上传或无；有更新的版本未采用时一眼可见。 */
  function renderAdopted(asset) {
    const { adoptedVersion, latestSucceeded } = asset.generation;
    if (adoptedVersion !== null) {
      const newer = latestSucceeded !== null && latestSucceeded > adoptedVersion;
      return aiUi.h('div', { class: 'asset-status' }, aiUi.h('span', { text: `v${adoptedVersion}` }), newer ? aiUi.h('span', { class: 'description', text: `最新 v${latestSucceeded} 未采用` }) : null);
    }
    return aiUi.h('span', { class: 'description', text: asset.fileCount > 0 ? '手动上传' : '无' });
  }

  /** 操作列：两行按钮。第一行是生成相关（提示词生成、重试、取消，生成图片（音频），提示词），第二行是版本、修改、删除；图片生成无法取消，提示词或图片生成中“提示词”“生成”按钮不可用。 */
  function renderActions(asset) {
    const buttons = [];
    const hasPrompt = Boolean(asset.promptZh || asset.promptEn);
    if (asset.promptStatus === 'running') {
      buttons.push(aiUi.button({ text: '取消提示词', compact: true, ariaLabel: `取消提示词：${asset.name}`, onClick: () => void runAction(REQUEST_CANCEL_PROMPT, { id: asset.id }) }).element);
    } else if (asset.promptStatus === 'failed' || asset.promptStatus === 'canceled') {
      buttons.push(aiUi.button({ text: '重试提示词', compact: true, ariaLabel: `重试提示词：${asset.name}`, onClick: () => void runAction(REQUEST_GENERATE_PROMPT, { id: asset.id }) }).element);
    } else if (!hasPrompt || asset.isPromptOutdated) {
      const text = hasPrompt ? '重新生成提示词' : '生成提示词';
      buttons.push(aiUi.button({ text, compact: true, ariaLabel: `${text}：${asset.name}`, onClick: () => void generatePrompt(asset, hasPrompt) }).element);
    }
    const latest = asset.generation.latest;
    const generating = latest !== null && (latest.status === 'queued' || latest.status === 'running');
    const busy = generating || asset.promptStatus === 'running';
    const noun = asset.kind === KIND_AUDIO ? '音频' : '图片';
    const generate = aiUi.button({
      text: `生成${noun}`,
      compact: true,
      variant: 'primary',
      disabled: !asset.availability.available,
      ariaLabel: `生成${noun}：${asset.name}`,
      onClick: () => void window.aiAssetGenerate.open(asset)
    });
    if (!asset.availability.available) generate.element.title = asset.availability.reason || '';
    const promptButton = aiUi.button({
      text: '提示词',
      compact: true,
      disabled: busy,
      ariaLabel: `查看或修改提示词：${asset.name}`,
      onClick: () => openPromptForm(asset)
    });
    if (busy) promptButton.element.title = generating ? '正在生成，请等待完成。' : '提示词生成中，完成后再修改。';
    buttons.push(generate.element, promptButton.element);
    return aiUi.h(
      'div',
      { class: 'asset-actions' },
      aiUi.h('div', { class: 'asset-actions__row' }, buttons),
      aiUi.h(
        'div',
        { class: 'asset-actions__row' },
        aiUi.button({ text: '版本', compact: true, ariaLabel: `查看版本：${asset.name}`, onClick: () => window.aiAssetVersions.open(asset) }).element,
        aiUi.button({ kind: 'edit', compact: true, ariaLabel: `修改：${asset.name}`, onClick: () => openEditForm(asset) }).element,
        aiUi.button({ kind: 'delete', compact: true, ariaLabel: `删除：${asset.name}`, onClick: () => void deleteAsset(asset) }).element
      )
    );
  }

  /** 重新生成提示词时已有内容先确认覆盖，再请求后台生成。 */
  async function generatePrompt(asset, hasPrompt) {
    if (hasPrompt) {
      const confirmed = await aiUi.confirm({ title: '覆盖现有提示词', message: '将用重新生成的提示词覆盖现有提示词，确定吗？', confirmText: '覆盖', cancelText: '取消' });
      if (!confirmed) return;
    }
    await runAction(REQUEST_GENERATE_PROMPT, { id: asset.id });
  }

  /** 资产表格的列；“图片”列的标题随资产类型变化，“分类”列按分类标识取名称，未分类显示占位文字。 */
  function buildColumns() {
    const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
    return [
      kind === KIND_AUDIO
        ? { title: '试听', width: 130, minWidth: 110, render: (asset) => renderPreview(asset) }
        : { title: '预览', width: 80, minWidth: 64, render: (asset) => renderPreview(asset) },
      { title: '名称', width: '20%', minWidth: 140, render: (asset) => aiUi.tableMainCell({ text: asset.name, description: describeAsset(asset) }) },
      { title: '分类', width: 100, minWidth: 80, emptyText: '未分类', render: (asset) => categoryNames.get(asset.categoryId) },
      { title: '提示词', width: 110, minWidth: 90, render: renderPromptStatus },
      { title: kind === KIND_AUDIO ? '音频' : '图片', width: 130, minWidth: 100, render: renderGenerationStatus },
      { title: '当前采用', width: 100, minWidth: 80, render: renderAdopted },
      {
        title: '使用',
        width: 70,
        nowrap: true,
        muted: (asset) => asset.episodeCount === 0,
        render: (asset) => (asset.episodeCount === 0 ? '未使用' : `${asset.episodeCount} 集`)
      },
      {
        title: '更新时间',
        width: 100,
        nowrap: true,
        muted: true,
        render: (asset) => formatRelativeTime(asset.updatedAt),
        tooltip: (asset) => new Date(asset.updatedAt).toLocaleString('zh-CN')
      },
      { title: '操作', type: 'actions', render: renderActions }
    ];
  }

  /** 弹出“分类管理”页：列出当前类型的分类，可创建、编辑、删除。 */
  function openCategoryManager() {
    if (!kind) return;
    window.aiAssetCategories.open({ kind, label: KIND_LABELS[kind], categories });
  }

  /** 分类下拉：全部、未分类、各分类，选项后面带资产数量；选项内容没变化时不重建。 */
  function renderCategoryFilter() {
    const noneCount = assets.filter((asset) => asset.categoryId === null).length;
    const options = [
      { value: FILTER_ALL, label: `全部（${assets.length}）` },
      { value: FILTER_NONE, label: `未分类（${noneCount}）` },
      ...categories.map((category) => ({ value: String(category.id), label: `${category.name}（${category.assetCount}）` }))
    ];
    const key = options.map((option) => `${option.value}:${option.label}`).join('|');
    if (key === categoryOptionsKey) return;
    categoryOptionsKey = key;
    const select = aiUi.select({
      options,
      value: categoryFilter,
      allowEmpty: false,
      ariaLabel: '按分类筛选',
      onChange: (value) => {
        categoryFilter = value;
        renderContent();
      }
    });
    categorySlot.textContent = '';
    categorySlot.append(select.element);
  }

  /** 资产是否符合当前的分类筛选。 */
  function matchesCategory(asset) {
    if (categoryFilter === FILTER_ALL) return true;
    if (categoryFilter === FILTER_NONE) return asset.categoryId === null;
    return String(asset.categoryId) === categoryFilter;
  }

  /** 空状态和错误状态。 */
  function renderState(text, button) {
    return aiUi.h('div', { class: 'assets-state' }, aiUi.h('p', { class: 'description', text }), button && button.element);
  }

  /** 按当前状态刷新内容区：按名称关键字筛选。 */
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
    const visible = assets.filter((asset) => matchesCategory(asset) && asset.name.toLowerCase().includes(text));
    contentElement.append(visible.length === 0 ? renderState('没有匹配的资产。') : aiUi.table({ columns: buildColumns(), rows: visible, ariaLabel: '资产' }).element);
  }

  /** 渲染页面骨架：搜索框、分类筛选与分类管理按钮、操作结果、资产区。 */
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
    categorySlot = aiUi.h('div', { class: 'assets-filter' });
    manageButton = aiUi.button({ text: '分类管理', disabled: true, onClick: openCategoryManager });
    document.getElementById('page-toolbar').append(aiUi.h('div', { class: 'assets-search' }, search.element), categorySlot, manageButton.element);

    messageElement = aiUi.h('p', { class: 'assets-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div');
    root.append(messageElement, contentElement);
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
