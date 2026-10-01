// ------------------------------------------------------------------------
// 名称：project-detail.js
// 说明：项目详情层脚本：在项目列表页内以弹出页面显示项目摘要与作品表格，按素材来源筛选与新建作品、弹出创意产出层、带名称确认的删除作品。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：通过 aiProjectDetail.open(projectId, request) 打开，同时只有一个详情层；请求载荷都带 projectId，请求与事件名称与 src/app/pages/project-detail-handlers.ts、src/app/forms/work-form.ts 一致；依赖 form/form-runtime.js（aiForm）、stage/stage.js（aiStage）与 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'detail.load';
  const REQUEST_PREPARE_DELETE_WORK = 'detail.prepareDeleteWork';
  const REQUEST_DELETE_WORK = 'detail.deleteWork';
  const EVENT_CHANGED = 'detail.changed';
  const EVENT_OPEN_STAGE = 'detail.openStage';
  const FORM_WORK_CREATE = 'work.create';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const UNSET_TEXT = '未设置';
  const DEFAULT_TITLE = '项目详情';
  const FILTER_ALL = 'all';
  const REFRESH_DELAY_MS = 150;
  const PAGE_WIDTH = 960;
  const PAGE_HEIGHT = 640;
  const PAGE_MIN_WIDTH = 420;
  const PAGE_MIN_HEIGHT = 360;
  const SOURCE_TYPES = [
    { value: 'text', label: '文字灵感' },
    { value: 'image', label: '图片灵感' },
    { value: 'novel', label: '小说改编' }
  ];
  const SOURCE_LABELS = Object.fromEntries(SOURCE_TYPES.map((item) => [item.value, item.label]));
  const KIND_LABELS = { single: '单个短视频', series: '多集短片' };

  const { formatRelativeTime, stageStatusLabel, stageStatusClass } = window.pageFormat;

  /** 已打开的详情层：项目标识 → { handle, refresh, openStage, handleRequest }。 */
  const openViews = new Map();

  /** 创意状态单元格：状态文字加版本号，生成中附带进度。 */
  function renderCreativeStatus(creative) {
    if (creative.display === 'none') {
      return aiUi.h('span', { class: stageStatusClass('none'), text: stageStatusLabel('none') });
    }
    const progress = creative.progressText ? `（${creative.progressText}）` : '';
    return aiUi.h('span', {
      class: stageStatusClass(creative.display),
      text: `v${creative.version} ${stageStatusLabel(creative.display)}${progress}`
    });
  }

  /** 空状态和错误状态。 */
  function renderState(text, button) {
    return aiUi.h('div', { class: 'detail-state' }, aiUi.h('p', { class: 'description', text }), button && button.element);
  }

  /**
   * 为一个项目创建详情层：弹出页面、加载数据并随宿主事件刷新。
   * @param {number} projectId 项目标识。
   * @returns 详情层的操作集合。
   */
  function createDetailView(projectId) {
    let project = null;
    let works = [];
    let loadError = '';
    let isLoading = true;
    let isFormOpen = false;
    /** 新建表单还开着时收到的「弹出产出层」请求，表单关闭后再打开。 */
    let pendingStageWorkId = null;
    let filterSource = FILTER_ALL;
    let refreshTimer = 0;
    let handle = null;

    const infoElement = aiUi.h('div', { class: 'detail-head__info' });
    const messageElement = aiUi.h('p', { class: 'detail-message', hidden: true, attrs: { role: 'status' } });
    const worksElement = aiUi.h('div');
    const filterSelect = aiUi.select({
      options: [{ value: FILTER_ALL, label: '全部素材来源' }, ...SOURCE_TYPES],
      value: FILTER_ALL,
      allowEmpty: false,
      ariaLabel: '按素材来源筛选',
      onChange: (value) => {
        filterSource = value;
        renderWorks();
      }
    });
    const headElement = aiUi.h(
      'header',
      { class: 'detail-head' },
      infoElement,
      aiUi.h('div', { class: 'detail-head__filter' }, filterSelect.element)
    );
    const assetsElement = aiUi.h(
      'section',
      { class: 'detail-assets' },
      aiUi.h('h2', { text: '资产' }),
      aiUi.h('p', { class: 'description', text: '角色、场景、道具、特效与音频资产将在后续版本提供。' })
    );
    const root = aiUi.h('div', { class: 'detail-view' }, headElement, messageElement, worksElement, assetsElement);

    /** 发起带项目标识的请求。 */
    function call(name, payload) {
      return window.hostBridge.request(name, { ...payload, projectId });
    }

    /** 在操作结果区显示文字；空串表示清除。 */
    function showMessage(text, isError) {
      messageElement.textContent = text;
      messageElement.className = isError ? 'detail-message status-error' : 'detail-message status-success';
      messageElement.hidden = text === '';
    }

    /** 发起请求，失败时在操作结果区显示原因；成功返回响应数据，失败返回 undefined。 */
    async function runAction(name, payload) {
      showMessage('', false);
      try {
        return await call(name, payload);
      } catch (error) {
        showMessage((error && error.message) || GENERIC_ERROR_TEXT, true);
        return undefined;
      }
    }

    /** 加载项目与作品并刷新界面；showLoading 为 false 时保留现有内容（后台刷新）。 */
    async function loadDetail(showLoading) {
      if (showLoading) {
        isLoading = true;
        render();
      }
      loadError = '';
      try {
        const data = await call(REQUEST_LOAD);
        project = data.project;
        works = data.works;
        handle.setTitle(project.name);
        // 作品被删除（或随所属项目一起删除）后，它的产出层没有意义，自动关闭。
        aiStage.closeMissing(works.map((work) => work.id));
      } catch (error) {
        loadError = (error && error.message) || '项目加载失败。';
      }
      isLoading = false;
      render();
    }

    /** 数据变化后稍作合并再刷新，生成进度频繁推送时避免反复重绘。 */
    function scheduleRefresh() {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadDetail(false), REFRESH_DELAY_MS);
    }

    /** 弹出表单；已有表单打开时忽略，避免重复点击叠出多个。 */
    async function showForm(options) {
      if (isFormOpen) return;
      isFormOpen = true;
      try {
        await aiForm.open(options);
      } finally {
        isFormOpen = false;
        if (pendingStageWorkId !== null) {
          const workId = pendingStageWorkId;
          pendingStageWorkId = null;
          aiStage.open(workId);
        }
      }
    }

    /** 弹出作品的创意产出层；表单还开着时等它关闭后再弹出，避免两个弹出页同时出现。 */
    function openStage(workId) {
      if (isFormOpen) pendingStageWorkId = workId;
      else aiStage.open(workId);
    }

    /** 弹出“新建作品”表单，素材来源由入口决定；同时取消筛选，保证新建的作品在列表中可见。 */
    function openCreateWorkForm(sourceType) {
      if (!project) return;
      filterSource = FILTER_ALL;
      filterSelect.setValue(FILTER_ALL);
      renderWorks();
      void showForm({ form: FORM_WORK_CREATE, params: { projectId, sourceType } });
    }

    /** 删除作品：先取名称，再用页内删除对话框要求输入作品名称，最后请求删除。 */
    async function deleteWork(work) {
      const prepared = await runAction(REQUEST_PREPARE_DELETE_WORK, { id: work.id });
      if (!prepared) return;

      const confirmed = await aiUi.confirmDelete({
        title: '删除作品',
        message: `将删除作品“${prepared.name}”及其素材、创意产出等全部内容，且无法恢复。`,
        confirmName: prepared.name,
        nameLabel: '作品名称'
      });
      if (!confirmed) return;

      const result = await runAction(REQUEST_DELETE_WORK, { id: work.id, confirmName: prepared.name });
      if (result) showMessage(`已删除作品“${result.name}”。`, false);
    }

    /** 作品表格的列。 */
    const workColumns = [
      {
        title: '作品名称',
        width: '30%',
        minWidth: 180,
        render: (work) => aiUi.tableMainCell({ text: work.name, description: KIND_LABELS[work.kind] || '' })
      },
      { title: '素材来源', width: '13%', minWidth: 90, render: (work) => aiUi.chip({ text: SOURCE_LABELS[work.sourceType] || UNSET_TEXT }) },
      { title: '创意', width: '18%', minWidth: 120, render: (work) => renderCreativeStatus(work.creative) },
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
            onClick: () => openStage(work.id)
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

    /** 摘要：描述、视觉风格、默认画幅与分辨率（项目名称显示在弹出页面的标题行）。 */
    function renderInfo() {
      infoElement.textContent = '';
      if (!project) return;
      const chips = [
        ['视觉风格', project.visualStyle],
        ['默认画幅', project.defaultAspectRatio],
        ['默认分辨率', project.defaultResolution]
      ].map(([label, value]) => aiUi.chip({ text: `${label}：${value || UNSET_TEXT}` }));

      // 直接使用 DOM 的 append 时 null 会变成文字“null”，先去掉空项。
      infoElement.append(
        ...[
          project.description ? aiUi.h('p', { class: 'description', text: project.description }) : null,
          aiUi.h('div', { class: 'detail-chips' }, chips)
        ].filter(Boolean)
      );
    }

    /** 作品区：按素材来源筛选后显示表格或空状态。 */
    function renderWorks() {
      worksElement.textContent = '';
      if (isLoading) {
        worksElement.append(renderState('加载中…'));
        return;
      }
      if (loadError) {
        worksElement.append(renderState(loadError, aiUi.button({ text: '重试', onClick: () => void loadDetail(true) })));
        return;
      }
      if (works.length === 0) {
        worksElement.append(renderState('这个项目还没有作品，在侧栏“创作”分区选择素材来源，点“添加”新建一个。'));
        return;
      }
      const visible = filterSource === FILTER_ALL ? works : works.filter((work) => work.sourceType === filterSource);
      worksElement.append(
        visible.length === 0
          ? renderState('没有匹配的作品。')
          : aiUi.table({ columns: workColumns, rows: visible, ariaLabel: '作品' }).element
      );
    }

    function render() {
      renderInfo();
      renderWorks();
    }

    /** 处理宿主带来的要求：按素材来源筛选，或直接弹出该来源的新建作品表单。 */
    async function handleRequest(request) {
      if (!request) return;
      if (request.filterSource) {
        filterSource = request.filterSource;
        filterSelect.setValue(filterSource);
        renderWorks();
      }
      if (request.createSource) {
        // 项目还没加载完时先等一次加载。
        if (!project) await initialLoad;
        openCreateWorkForm(request.createSource);
      }
    }

    handle = aiUi.openPage({
      title: DEFAULT_TITLE,
      content: root,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      minWidth: PAGE_MIN_WIDTH,
      minHeight: PAGE_MIN_HEIGHT
    });
    const initialLoad = loadDetail(true);
    void handle.closed.then(() => {
      window.clearTimeout(refreshTimer);
      openViews.delete(projectId);
      // 详情层关闭（含项目被删除时被动关闭）后，叠在它上面的产出层不再有意义。
      aiStage.closeMissing([]);
    });
    openViews.set(projectId, { handle, refresh: scheduleRefresh, openStage, handleRequest });
    return openViews.get(projectId);
  }

  /**
   * 打开项目的详情层；已经打开时聚焦已有的，并处理附带的要求。
   * @param {number} projectId 项目标识。
   * @param {{ filterSource?: string, createSource?: string }} [request] 附带的要求。
   * @returns 弹出页面的句柄。
   */
  function open(projectId, request) {
    // 同时只保留一个详情层。
    for (const [openedId, entry] of openViews) {
      if (openedId !== projectId) entry.handle.close('api');
    }
    const existing = openViews.get(projectId);
    const entry = existing || createDetailView(projectId);
    if (existing) existing.handle.element.focus();
    void entry.handleRequest(request);
    return entry.handle;
  }

  /** 关闭项目已不存在的详情层。 */
  function closeMissing(existingProjectIds) {
    for (const [projectId, entry] of openViews) {
      if (!existingProjectIds.includes(projectId)) entry.handle.close('api');
    }
  }

  window.hostBridge.onEvent(EVENT_CHANGED, () => {
    for (const entry of openViews.values()) entry.refresh();
  });
  window.hostBridge.onEvent(EVENT_OPEN_STAGE, (payload) => {
    if (!payload) return;
    for (const entry of openViews.values()) entry.openStage(payload.workId);
  });

  window.aiProjectDetail = { open, closeMissing };
})();
