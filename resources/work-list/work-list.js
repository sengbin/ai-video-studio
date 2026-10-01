// ------------------------------------------------------------------------
// 名称：work-list.js
// 说明：作品列表页脚本：列出某种素材来源下所有项目的作品（或跨来源的剧本视图），按项目与名称关键字筛选，在页内弹出页面中新建、编辑作品、生成剧本，弹出创意与剧本产出层，带名称确认地删除作品。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-01
// 备注：请求与事件名称与 src/app/pages/work-list-handlers.ts、src/app/forms/work-form.ts、src/app/forms/screenplay-form.ts 一致；依赖 form/form-runtime.js（aiForm）、stage/stage.js（aiStage）与 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'works.load';
  const REQUEST_TAKE_PENDING = 'works.takePending';
  const REQUEST_PREPARE_DELETE = 'works.prepareDelete';
  const REQUEST_DELETE = 'works.delete';
  const EVENT_CHANGED = 'works.changed';
  const EVENT_ACTION = 'works.action';
  const EVENT_OPEN_STAGE = 'works.openStage';
  const EVENT_START_SCREENPLAY = 'works.startScreenplay';
  const ACTION_CREATE = 'create';
  const FORM_CREATE = 'work.create';
  const FORM_EDIT = 'work.edit';
  const FORM_START_SCREENPLAY = 'screenplay.start';
  const FORM_PICK_SCREENPLAY = 'screenplay.pick';
  const STAGE_CREATIVE = 'creative';
  const STAGE_SCREENPLAY = 'screenplay';
  const VIEW_SCREENPLAY = 'screenplay';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const FILTER_ALL = 'all';
  const REFRESH_DELAY_MS = 150;
  const KIND_LABELS = { single: '单个短视频', series: '多集短片' };
  const SOURCE_LABELS = { text: '文字灵感', image: '图片灵感', novel: '小说原文' };
  /** 剧本视图的状态筛选：值为剧本阶段的展示状态，none 表示还没开始。 */
  const STATUS_FILTER_OPTIONS = [
    { value: FILTER_ALL, label: '全部状态' },
    { value: 'none', label: '未开始' },
    { value: 'running', label: '生成中' },
    { value: 'pending', label: '待确认' },
    { value: 'approved', label: '已确认' },
    { value: 'failed', label: '失败' },
    { value: 'canceled', label: '已取消' }
  ];

  const { formatRelativeTime, stageStatusLabel, stageStatusClass } = window.pageFormat;

  const root = document.getElementById('app');
  /** 页面绑定的视图（素材来源或剧本），首次加载成功后由宿主告知。 */
  let view = '';
  let projects = [];
  let works = [];
  let loadError = '';
  let isLoading = true;
  let isFormOpen = false;
  /** 表单还开着时收到的「稍后执行」请求（如弹出产出层、打开下一个表单），表单关闭后执行。 */
  let afterFormClosed = null;
  let filterProjectId = FILTER_ALL;
  let filterStatus = FILTER_ALL;
  let keyword = '';
  let refreshTimer = 0;
  /** 项目下拉当前对应的项目清单标记，清单变化时才重建下拉；为 null 表示还没有渲染过。 */
  let projectOptionsKey = null;
  let projectSlot = null;
  let statusSlot = null;
  let contentElement = null;
  let messageElement = null;

  /** 在操作结果区显示文字；空串表示清除。 */
  function showMessage(text, isError) {
    messageElement.textContent = text;
    messageElement.className = isError ? 'works-message status-error' : 'works-message status-success';
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

  /** 状态下拉：只在剧本视图显示，知道视图后建一次。 */
  function renderStatusFilter() {
    if (view !== VIEW_SCREENPLAY || statusSlot.childElementCount > 0) return;
    const select = aiUi.select({
      options: STATUS_FILTER_OPTIONS,
      value: filterStatus,
      allowEmpty: false,
      ariaLabel: '按剧本状态筛选',
      onChange: (value) => {
        filterStatus = value;
        renderContent();
      }
    });
    statusSlot.append(select.element);
    statusSlot.hidden = false;
  }

  /** 加载作品并刷新界面；showLoading 为 false 时保留现有内容（后台刷新）。 */
  async function loadWorks(showLoading) {
    if (showLoading) {
      isLoading = true;
      renderContent();
    }
    loadError = '';
    try {
      const data = await window.hostBridge.request(REQUEST_LOAD);
      view = data.view;
      projects = data.projects;
      works = data.works;
      // 作品被删除（或随所属项目一起删除）后，它的产出层没有意义，自动关闭。
      aiStage.closeMissing(works.map((work) => work.id));
    } catch (error) {
      loadError = (error && error.message) || '作品加载失败。';
    }
    isLoading = false;
    renderProjectFilter();
    renderStatusFilter();
    renderContent();
  }

  /** 数据变化后稍作合并再刷新，生成进度频繁推送时避免反复重绘。 */
  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadWorks(false), REFRESH_DELAY_MS);
  }

  /** 弹出表单；已有表单打开时忽略，避免重复点击叠出多个。 */
  async function showForm(options) {
    if (isFormOpen) return;
    isFormOpen = true;
    try {
      await aiForm.open(options);
    } finally {
      isFormOpen = false;
      const next = afterFormClosed;
      afterFormClosed = null;
      if (next) next();
    }
  }

  /** 执行一个动作；表单还开着时等它关闭后再执行，避免两个弹出页同时出现。 */
  function runAfterForm(action) {
    if (isFormOpen) afterFormClosed = action;
    else action();
  }

  /** 弹出作品某个阶段的产出层。 */
  function openStage(workId, stage) {
    runAfterForm(() => aiStage.open(workId, stage));
  }

  /** 弹出“新建作品”表单（剧本视图中为“选择作品”）；筛选了某个项目时把它作为默认值或限定范围。 */
  function openCreateForm() {
    const params = view === VIEW_SCREENPLAY ? {} : { sourceType: view };
    if (filterProjectId !== FILTER_ALL) params.projectId = Number(filterProjectId);
    void showForm({ form: view === VIEW_SCREENPLAY ? FORM_PICK_SCREENPLAY : FORM_CREATE, params });
  }

  /** 弹出“编辑作品”表单。 */
  function openEditForm(work) {
    void showForm({ form: FORM_EDIT, params: { workId: work.id } });
  }

  /** 弹出“生成剧本”表单；创意已确认才能打开。 */
  function openScreenplayForm(work) {
    void showForm({ form: FORM_START_SCREENPLAY, params: { workId: work.id } });
  }

  /** 删除作品：先取名称，再用页内删除对话框要求输入作品名称，最后请求删除。 */
  async function deleteWork(work) {
    const prepared = await runAction(REQUEST_PREPARE_DELETE, { id: work.id });
    if (!prepared) return;

    const confirmed = await aiUi.confirmDelete({
      title: '删除作品',
      message: `将删除作品“${prepared.name}”及其素材、创意、剧本等全部内容，且无法恢复。`,
      confirmName: prepared.name,
      nameLabel: '作品名称'
    });
    if (!confirmed) return;

    const result = await runAction(REQUEST_DELETE, { id: work.id, confirmName: prepared.name });
    if (result) showMessage(`已删除作品“${result.name}”。`, false);
  }

  /** 处理宿主带来的请求：弹出“新建作品”或“选择作品”表单；页面还没加载完时先等一次加载，才知道视图。 */
  async function handleRequest(request) {
    if (!request || request.action !== ACTION_CREATE) return;
    if (!view) await initialLoad;
    if (view) openCreateForm();
  }

  /** 阶段状态单元格：状态文字加版本号，生成中附带进度，上游已变更时加标记。 */
  function renderStageStatus(summary) {
    if (summary.display === 'none') {
      return aiUi.h('span', { class: stageStatusClass('none'), text: stageStatusLabel('none') });
    }
    const progress = summary.progressText ? `（${summary.progressText}）` : '';
    const stale = summary.stale ? '，上游已变更' : '';
    return aiUi.h('span', {
      class: summary.stale ? 'status-warning' : stageStatusClass(summary.display),
      text: `v${summary.version} ${stageStatusLabel(summary.display)}${progress}${stale}`
    });
  }

  /** 剧本操作按钮（剧本视图）：已有剧本记录时查看；没有时创意已确认才能生成。 */
  function renderScreenplayButton(work) {
    if (work.screenplay.runId !== null) {
      return aiUi.button({
        text: '查看剧本',
        compact: true,
        ariaLabel: `查看剧本：${work.name}`,
        onClick: () => openStage(work.id, STAGE_SCREENPLAY)
      }).element;
    }
    return aiUi.button({
      text: '生成剧本',
      compact: true,
      disabled: !work.canStartScreenplay,
      ariaLabel: `生成剧本：${work.name}`,
      onClick: () => openScreenplayForm(work)
    }).element;
  }

  /** 作品表格的列（素材来源视图）。 */
  const WORK_COLUMNS = [
    {
      title: '作品名称',
      width: '26%',
      minWidth: 180,
      render: (work) => aiUi.tableMainCell({ text: work.name, description: KIND_LABELS[work.kind] || '' })
    },
    { title: '所属项目', width: '16%', minWidth: 120, render: (work) => aiUi.chip({ text: work.projectName }) },
    { title: '创意', width: '16%', minWidth: 120, render: (work) => renderStageStatus(work.creative) },
    { title: '剧本', width: '16%', minWidth: 120, render: (work) => renderStageStatus(work.screenplay) },
    {
      title: '创建时间',
      width: 110,
      nowrap: true,
      muted: true,
      render: (work) => formatRelativeTime(work.createdAt),
      tooltip: (work) => new Date(work.createdAt).toLocaleString('zh-CN')
    },
    {
      title: '操作',
      type: 'actions',
      render: (work) => [
        aiUi.button({
          text: '查看创意',
          compact: true,
          disabled: work.creative.runId === null,
          ariaLabel: `查看创意：${work.name}`,
          onClick: () => openStage(work.id, STAGE_CREATIVE)
        }).element,
        aiUi.button({
          kind: 'edit',
          compact: true,
          ariaLabel: `修改：${work.name}`,
          onClick: () => openEditForm(work)
        }).element,
        aiUi.button({
          kind: 'delete',
          compact: true,
          ariaLabel: `删除：${work.name}`,
          onClick: () => void deleteWork(work)
        }).element
      ]
    }
  ];

  /** 集数与实体数；还没有抽取结果时显示破折号。 */
  function formatContentCounts(counts) {
    return counts ? `${counts.episodes} 集 · ${counts.entities} 个实体` : '—';
  }

  /** 作品表格的列（剧本视图）：跨素材来源，只有剧本相关的操作。 */
  const SCREENPLAY_COLUMNS = [
    {
      title: '作品名称',
      width: '26%',
      minWidth: 180,
      render: (work) => aiUi.tableMainCell({ text: work.name, description: KIND_LABELS[work.kind] || '' })
    },
    { title: '所属项目', width: '16%', minWidth: 120, render: (work) => aiUi.chip({ text: work.projectName }) },
    { title: '素材来源', width: '12%', minWidth: 100, render: (work) => SOURCE_LABELS[work.sourceType] || '' },
    { title: '剧本', width: '18%', minWidth: 140, render: (work) => renderStageStatus(work.screenplay) },
    { title: '内容', width: '14%', minWidth: 120, muted: true, nowrap: true, render: (work) => formatContentCounts(work.contentCounts) },
    {
      title: '创建时间',
      width: 110,
      nowrap: true,
      muted: true,
      render: (work) => formatRelativeTime(work.createdAt),
      tooltip: (work) => new Date(work.createdAt).toLocaleString('zh-CN')
    },
    { title: '操作', type: 'actions', render: (work) => [renderScreenplayButton(work)] }
  ];

  /** 空状态和错误状态。 */
  function renderState(text, button) {
    return aiUi.h('div', { class: 'works-state' }, aiUi.h('p', { class: 'description', text }), button && button.element);
  }

  /** 按当前状态刷新内容区：先按项目、再按名称关键字筛选。 */
  function renderContent() {
    contentElement.textContent = '';
    if (isLoading) {
      contentElement.append(renderState('加载中…'));
      return;
    }
    if (loadError) {
      contentElement.append(renderState(loadError, aiUi.button({ text: '重试', onClick: () => void loadWorks(true) })));
      return;
    }
    if (works.length === 0) {
      contentElement.append(
        view === VIEW_SCREENPLAY
          ? renderState('还没有可生成剧本的作品。请先在“创作”列表中新建作品并确认创意。')
          : renderState('还没有作品。', aiUi.button({ text: '新建作品', kind: 'add', onClick: openCreateForm }))
      );
      return;
    }
    const text = keyword.trim().toLowerCase();
    const visible = works.filter(
      (work) =>
        (filterProjectId === FILTER_ALL || String(work.projectId) === filterProjectId) &&
        (filterStatus === FILTER_ALL || work.screenplay.display === filterStatus) &&
        work.name.toLowerCase().includes(text)
    );
    contentElement.append(
      visible.length === 0
        ? renderState('没有匹配的作品。')
        : aiUi.table({ columns: view === VIEW_SCREENPLAY ? SCREENPLAY_COLUMNS : WORK_COLUMNS, rows: visible, ariaLabel: '作品' }).element
    );
  }

  /** 渲染页面骨架：搜索框与项目筛选、操作结果、作品区。 */
  function renderPage() {
    const search = aiUi.textInput({
      type: 'search',
      placeholder: '搜索作品名称',
      ariaLabel: '搜索作品名称',
      onChange: (value) => {
        keyword = value;
        renderContent();
      }
    });
    projectSlot = aiUi.h('div', { class: 'works-header__project' });
    statusSlot = aiUi.h('div', { class: 'works-header__project', hidden: true });
    const header = aiUi.h(
      'div',
      { class: 'works-header' },
      aiUi.h('div', { class: 'works-header__search' }, search.element),
      projectSlot,
      statusSlot
    );

    messageElement = aiUi.h('p', { class: 'works-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div');
    root.append(header, messageElement, contentElement);
    renderProjectFilter();
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, scheduleRefresh);
  window.hostBridge.onEvent(EVENT_ACTION, (request) => void handleRequest(request));
  window.hostBridge.onEvent(EVENT_OPEN_STAGE, (payload) => {
    if (payload) openStage(payload.workId, payload.stage);
  });
  // “选择作品”表单提交后，表单关闭再打开该作品的“生成剧本”表单。
  window.hostBridge.onEvent(EVENT_START_SCREENPLAY, (payload) => {
    if (payload) runAfterForm(() => void showForm({ form: FORM_START_SCREENPLAY, params: { workId: payload.workId } }));
  });
  const initialLoad = loadWorks(true);
  // 页面打开前已登记的请求（如侧栏点“添加”），加载完成后主动取走。
  void initialLoad
    .then(() => window.hostBridge.request(REQUEST_TAKE_PENDING))
    .then((result) => handleRequest(result && result.request))
    .catch(() => undefined);
})();
