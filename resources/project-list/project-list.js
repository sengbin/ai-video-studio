// ------------------------------------------------------------------------
// 名称：project-list.js
// 说明：项目列表页脚本：用界面组件库渲染项目表格，处理搜索、在页内弹出页面中新建与编辑、带名称确认的删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求与事件名称与 src/app/pages/project-list-handlers.ts、src/app/forms/project-form.ts 一致；依赖 form/form-runtime.js（aiForm）与 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LIST = 'projects.list';
  const REQUEST_TAKE_PENDING_ACTION = 'projects.takePendingAction';
  const REQUEST_PREPARE_DELETE = 'projects.prepareDelete';
  const REQUEST_DELETE = 'projects.delete';
  const EVENT_CHANGED = 'projects.changed';
  const EVENT_ACTION = 'projects.action';
  const ACTION_CREATE = 'create';
  const FORM_CREATE = 'project.create';
  const FORM_EDIT = 'project.edit';

  const PAGE_TITLE = '所有项目';
  const UNSET_TEXT = '未设置';
  const GENERIC_ERROR_TEXT = '操作失败，请重试。';

  const { formatRelativeTime } = window.pageFormat;

  const root = document.getElementById('app');
  let projects = [];
  let loadError = '';
  let isLoading = true;
  let isFormOpen = false;
  let filterText = '';
  let contentElement = null;
  let messageElement = null;

  /** 在操作结果区显示文字；空串表示清除。 */
  function showMessage(text, isError) {
    messageElement.textContent = text;
    messageElement.className = isError ? 'list-message status-error' : 'list-message status-success';
    messageElement.hidden = text === '';
  }

  /** 处理宿主带来的请求：目前只有弹出“新建项目”表单。 */
  function handleRequest(request) {
    if (request && request.action === ACTION_CREATE) openCreateForm();
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

  /** 加载项目列表并刷新界面。 */
  async function loadProjects() {
    isLoading = true;
    loadError = '';
    renderContent();
    try {
      projects = await window.hostBridge.request(REQUEST_LIST);
    } catch (error) {
      loadError = (error && error.message) || '项目列表加载失败。';
    }
    isLoading = false;
    renderContent();
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

  /** 在页内弹出“新建项目”表单。 */
  function openCreateForm() {
    void showForm({ form: FORM_CREATE });
  }

  /** 在页内弹出“编辑项目”表单。 */
  function openEditForm(project) {
    void showForm({ form: FORM_EDIT, params: { id: project.id } });
  }

  /** 删除项目：先取影响范围，再用页内删除对话框要求输入项目名称，最后请求删除。 */
  async function deleteProject(project) {
    const impact = await runAction(REQUEST_PREPARE_DELETE, { id: project.id });
    if (!impact) return;

    const confirmed = await aiUi.confirmDelete({
      title: '删除项目',
      message: `将删除项目“${impact.name}”及其下的全部内容，且无法恢复：`,
      details: [`${impact.workCount} 个作品`, `${impact.videoResultCount} 个视频结果`],
      confirmName: impact.name,
      nameLabel: '项目名称'
    });
    if (!confirmed) return;

    const result = await runAction(REQUEST_DELETE, { id: project.id, confirmName: impact.name });
    if (result) showMessage(`已删除项目“${result.name}”。`, false);
  }

  /** 项目表格的列：数量为 0 时淡化，操作列放修改与删除按钮。 */
  const PROJECT_COLUMNS = [
    {
      title: '项目名称',
      width: '34%',
      minWidth: 180,
      render: (project) => aiUi.tableMainCell({ text: project.name, description: project.description })
    },
    {
      title: '视觉风格',
      width: '16%',
      minWidth: 110,
      emptyText: UNSET_TEXT,
      render: (project) => project.visualStyle && aiUi.chip({ text: project.visualStyle })
    },
    { title: '作品数', key: 'workCount', type: 'number', muted: (project) => project.workCount === 0 },
    {
      title: '更新时间',
      width: 110,
      nowrap: true,
      muted: true,
      render: (project) => formatRelativeTime(project.updatedAt),
      tooltip: (project) => new Date(project.updatedAt).toLocaleString('zh-CN')
    },
    {
      title: '操作',
      type: 'actions',
      render: (project) => [
        aiUi.button({
          kind: 'edit',
          compact: true,
          ariaLabel: `修改：${project.name}`,
          onClick: () => openEditForm(project)
        }).element,
        aiUi.button({
          kind: 'delete',
          compact: true,
          ariaLabel: `删除：${project.name}`,
          onClick: () => void deleteProject(project)
        }).element
      ]
    }
  ];

  /** 项目表格。 */
  function renderTable(visibleProjects) {
    return aiUi.table({ columns: PROJECT_COLUMNS, rows: visibleProjects, ariaLabel: PAGE_TITLE }).element;
  }

  /** 空状态、加载中和错误状态。 */
  function renderState(text, button) {
    return aiUi.h('div', { class: 'list-state' }, aiUi.h('p', { class: 'description', text }), button && button.element);
  }

  /** 按当前状态刷新内容区。 */
  function renderContent() {
    contentElement.textContent = '';
    if (isLoading) {
      contentElement.append(renderState('加载中…'));
      return;
    }
    if (loadError) {
      contentElement.append(renderState(loadError, aiUi.button({ text: '重试', onClick: () => void loadProjects() })));
      return;
    }
    if (projects.length === 0) {
      contentElement.append(
        renderState('还没有项目。', aiUi.button({ text: '创建项目', kind: 'add', onClick: openCreateForm }))
      );
      return;
    }

    const keyword = filterText.trim().toLowerCase();
    const visibleProjects = projects.filter((project) => project.name.toLowerCase().includes(keyword));
    contentElement.append(visibleProjects.length === 0 ? renderState('没有匹配的项目。') : renderTable(visibleProjects));
  }

  /** 渲染页面骨架。 */
  function renderPage() {
    const search = aiUi.textInput({
      type: 'search',
      placeholder: '搜索项目名称',
      ariaLabel: '搜索项目名称',
      onChange: (value) => {
        filterText = value;
        renderContent();
      }
    });
    const toolbar = document.getElementById('page-toolbar');
    toolbar.append(aiUi.h('div', { class: 'list-search' }, search.element));

    messageElement = aiUi.h('p', { class: 'list-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div');
    root.append(messageElement, contentElement);
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, () => void loadProjects());
  window.hostBridge.onEvent(EVENT_ACTION, handleRequest);
  // 页面打开前已登记的请求（如侧栏点“创建项目”），加载完成后主动取走。
  window.hostBridge
    .request(REQUEST_TAKE_PENDING_ACTION)
    .then(handleRequest)
    .catch(() => undefined);
  void loadProjects();
})();
