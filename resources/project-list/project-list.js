// ------------------------------------------------------------------------
// 名称：project-list.js
// 说明：项目列表页脚本：用界面组件库渲染项目表格，处理搜索、在页内弹出页面中新建与编辑、带名称确认的删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求与事件名称与 src/app/pages/project-list-handlers.ts、src/app/forms/project-form.ts 一致；依赖 form/form-runtime.js（aiForm）。
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

  const PAGE_TITLE = '全部项目';
  const UNSET_TEXT = '未设置';
  const JUST_NOW_TEXT = '刚刚';
  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const RELATIVE_TIME_LIMIT_DAYS = 30;
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;

  const root = document.getElementById('app');
  let projects = [];
  let loadError = '';
  let isLoading = true;
  let isFormOpen = false;
  let filterText = '';
  let contentElement = null;
  let messageElement = null;

  /** 相对时间：一分钟内“刚刚”，30 天内用相对表述，更早显示日期。 */
  function formatRelativeTime(isoText) {
    const elapsed = Date.now() - Date.parse(isoText);
    if (Number.isNaN(elapsed) || elapsed < MINUTE_MS) return JUST_NOW_TEXT;
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (elapsed < HOUR_MS) return formatter.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
    if (elapsed < DAY_MS) return formatter.format(-Math.floor(elapsed / HOUR_MS), 'hour');
    if (elapsed < RELATIVE_TIME_LIMIT_DAYS * DAY_MS) return formatter.format(-Math.floor(elapsed / DAY_MS), 'day');
    return new Date(isoText).toLocaleDateString('zh-CN');
  }

  /** 在操作结果区显示文字；空串表示清除。 */
  function showMessage(text, isError) {
    messageElement.textContent = text;
    messageElement.className = isError ? 'list-message status-error' : 'list-message status-success';
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
      details: [`${impact.workCount} 个作品`, `${impact.assetCount} 个资产`, `${impact.videoResultCount} 个视频结果`],
      confirmName: impact.name,
      nameLabel: '项目名称'
    });
    if (!confirmed) return;

    const result = await runAction(REQUEST_DELETE, { id: project.id, confirmName: impact.name });
    if (result) showMessage(`已删除项目“${result.name}”。`, false);
  }

  /** 表格中的一行。 */
  function renderRow(project) {
    const editButton = aiUi.button({
      kind: 'edit',
      compact: true,
      ariaLabel: `修改：${project.name}`,
      onClick: () => openEditForm(project)
    });
    const deleteButton = aiUi.button({
      kind: 'delete',
      compact: true,
      ariaLabel: `删除：${project.name}`,
      onClick: () => void deleteProject(project)
    });

    return aiUi.h(
      'tr',
      {},
      aiUi.h(
        'td',
        {},
        aiUi.h('span', { class: 'project-name', text: project.name }),
        project.description ? aiUi.h('div', { class: 'description', text: project.description }) : null
      ),
      aiUi.h('td', { text: project.visualStyle || UNSET_TEXT }),
      aiUi.h('td', { class: 'column-number', text: String(project.workCount) }),
      aiUi.h('td', { class: 'column-number', text: String(project.assetCount) }),
      aiUi.h('td', {
        text: formatRelativeTime(project.updatedAt),
        attrs: { title: new Date(project.updatedAt).toLocaleString('zh-CN') }
      }),
      aiUi.h('td', { class: 'column-actions' }, editButton.element, deleteButton.element)
    );
  }

  /** 项目表格。 */
  function renderTable(visibleProjects) {
    const headings = [
      ['项目名称', ''],
      ['视觉风格', ''],
      ['作品数', 'column-number'],
      ['资产数', 'column-number'],
      ['更新时间', ''],
      ['操作', 'column-actions']
    ];
    const headRow = aiUi.h(
      'tr',
      {},
      headings.map(([text, className]) => aiUi.h('th', { class: className, text, attrs: { scope: 'col' } }))
    );
    return aiUi.h(
      'div',
      { class: 'table-container' },
      aiUi.h(
        'table',
        { class: 'project-table', attrs: { 'aria-label': PAGE_TITLE } },
        aiUi.h('thead', {}, headRow),
        aiUi.h('tbody', {}, visibleProjects.map(renderRow))
      )
    );
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
    const createButton = aiUi.button({ text: '创建项目', kind: 'add', onClick: openCreateForm });
    const toolbar = aiUi.h('div', { class: 'list-toolbar' }, aiUi.h('div', { class: 'list-search' }, search.element), createButton.element);

    messageElement = aiUi.h('p', { class: 'list-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div');
    root.append(aiUi.h('h1', { text: PAGE_TITLE }), toolbar, messageElement, contentElement);
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, () => void loadProjects());
  window.hostBridge.onEvent(EVENT_ACTION, (payload) => {
    if (payload && payload.action === ACTION_CREATE) openCreateForm();
  });
  // 页面打开前已登记的动作（如侧栏点“创建项目”），加载完成后主动取走。
  window.hostBridge
    .request(REQUEST_TAKE_PENDING_ACTION)
    .then((result) => {
      if (result && result.action === ACTION_CREATE) openCreateForm();
    })
    .catch(() => undefined);
  void loadProjects();
})();
