// ------------------------------------------------------------------------
// 名称：work-list.js
// 说明：作品列表页脚本：列出某种素材来源下所有项目的作品，按项目与名称关键字筛选，在页内弹出页面中新建、编辑作品、生成剧本，弹出创意与剧本产出层，带名称确认地删除作品。
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
  const ACTION_CREATE = 'create';
  const FORM_CREATE = 'work.create';
  const FORM_EDIT = 'work.edit';
  const FORM_START_SCREENPLAY = 'screenplay.start';
  const STAGE_CREATIVE = 'creative';
  const STAGE_SCREENPLAY = 'screenplay';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const FILTER_ALL = 'all';
  const REFRESH_DELAY_MS = 150;
  const KIND_LABELS = { single: '单个短视频', series: '多集短片' };

  const { formatRelativeTime, stageStatusLabel, stageStatusClass } = window.pageFormat;

  const root = document.getElementById('app');
  /** 页面绑定的素材来源，首次加载成功后由宿主告知。 */
  let sourceType = '';
  let projects = [];
  let works = [];
  let loadError = '';
  let isLoading = true;
  let isFormOpen = false;
  /** 表单还开着时收到的「弹出产出层」请求（{ workId, stage }），表单关闭后再打开。 */
  let pendingStage = null;
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

  /** 加载作品并刷新界面；showLoading 为 false 时保留现有内容（后台刷新）。 */
  async function loadWorks(showLoading) {
    if (showLoading) {
      isLoading = true;
      renderContent();
    }
    loadError = '';
    try {
      const data = await window.hostBridge.request(REQUEST_LOAD);
      sourceType = data.sourceType;
      projects = data.projects;
      works = data.works;
      // 作品被删除（或随所属项目一起删除）后，它的产出层没有意义，自动关闭。
      aiStage.closeMissing(works.map((work) => work.id));
    } catch (error) {
      loadError = (error && error.message) || '作品加载失败。';
    }
    isLoading = false;
    renderProjectFilter();
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
      if (pendingStage !== null) {
        const { workId, stage } = pendingStage;
        pendingStage = null;
        aiStage.open(workId, stage);
      }
    }
  }

  /** 弹出作品某个阶段的产出层；表单还开着时等它关闭后再弹出，避免两个弹出页同时出现。 */
  function openStage(workId, stage) {
    if (isFormOpen) pendingStage = { workId, stage };
    else aiStage.open(workId, stage);
  }

  /** 弹出“新建作品”表单；筛选了某个项目时把它作为所属项目的默认值。 */
  function openCreateForm() {
    const params = { sourceType };
    if (filterProjectId !== FILTER_ALL) params.projectId = Number(filterProjectId);
    void showForm({ form: FORM_CREATE, params });
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

  /** 处理宿主带来的请求：弹出“新建作品”表单；页面还没加载完时先等一次加载，才知道素材来源。 */
  async function handleRequest(request) {
    if (!request || request.action !== ACTION_CREATE) return;
    if (!sourceType) await initialLoad;
    if (sourceType) openCreateForm();
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

  /** 剧本操作按钮：已有剧本记录时查看；没有时创意已确认才能生成。 */
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

  /** 作品表格的列。 */
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
        renderScreenplayButton(work),
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
      contentElement.append(renderState('还没有作品。', aiUi.button({ text: '新建作品', kind: 'add', onClick: openCreateForm })));
      return;
    }
    const text = keyword.trim().toLowerCase();
    const visible = works.filter(
      (work) => (filterProjectId === FILTER_ALL || String(work.projectId) === filterProjectId) && work.name.toLowerCase().includes(text)
    );
    contentElement.append(
      visible.length === 0
        ? renderState('没有匹配的作品。')
        : aiUi.table({ columns: WORK_COLUMNS, rows: visible, ariaLabel: '作品' }).element
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
    const header = aiUi.h('div', { class: 'works-header' }, aiUi.h('div', { class: 'works-header__search' }, search.element), projectSlot);

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
  const initialLoad = loadWorks(true);
  // 页面打开前已登记的请求（如侧栏点“添加”），加载完成后主动取走。
  void initialLoad
    .then(() => window.hostBridge.request(REQUEST_TAKE_PENDING))
    .then((result) => handleRequest(result && result.request))
    .catch(() => undefined);
})();
