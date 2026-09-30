// ------------------------------------------------------------------------
// 名称：project-list.js
// 说明：项目列表页脚本：加载并渲染项目表格，处理搜索、创建、编辑与删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求与事件名称与 src/app/pages/project-list-handlers.ts 一致。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LIST = 'projects.list';
  const REQUEST_CREATE = 'projects.create';
  const REQUEST_EDIT = 'projects.edit';
  const REQUEST_DELETE = 'projects.delete';
  const EVENT_CHANGED = 'projects.changed';

  const PAGE_TITLE = '全部项目';
  const UNSET_TEXT = '未设置';
  const JUST_NOW_TEXT = '刚刚';
  const RELATIVE_TIME_LIMIT_DAYS = 30;
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;

  const root = document.getElementById('app');
  let projects = [];
  let loadError = '';
  let isLoading = true;
  let filterText = '';
  let contentElement = null;
  let messageElement = null;

  /**
   * 创建元素。
   * @param {string} tag 标签名。
   * @param {string} [className] 类名。
   * @param {string} [text] 文本内容。
   */
  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  /** 创建按钮。 */
  function createButton(label, className, onClick, ariaLabel) {
    const button = createElement('button', className, label);
    button.type = 'button';
    if (ariaLabel) button.setAttribute('aria-label', ariaLabel);
    button.addEventListener('click', onClick);
    return button;
  }

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
    messageElement.className = isError ? 'list-message status-error' : 'list-message';
    messageElement.hidden = text === '';
  }

  /** 发起请求，失败时在操作结果区显示原因。 */
  async function runAction(name, payload) {
    showMessage('', false);
    try {
      return await window.hostBridge.request(name, payload);
    } catch (error) {
      showMessage((error && error.message) || '操作失败，请重试。', true);
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

  /** 表格中的一行。 */
  function renderRow(project) {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    nameCell.append(createElement('span', 'project-name', project.name));
    if (project.description) {
      nameCell.append(createElement('div', 'description', project.description));
    }

    const styleCell = createElement('td', '', project.visualStyle || UNSET_TEXT);
    const workCell = createElement('td', 'column-number', String(project.workCount));
    const assetCell = createElement('td', 'column-number', String(project.assetCount));
    const timeCell = createElement('td', '', formatRelativeTime(project.updatedAt));
    timeCell.title = new Date(project.updatedAt).toLocaleString('zh-CN');

    const actionsCell = createElement('td', 'column-actions');
    actionsCell.append(
      createButton('编辑', 'button button-compact', () => void runAction(REQUEST_EDIT, { id: project.id }), `编辑：${project.name}`),
      createButton('删除', 'button button-compact button-danger', () => void runAction(REQUEST_DELETE, { id: project.id }), `删除：${project.name}`)
    );

    row.append(nameCell, styleCell, workCell, assetCell, timeCell, actionsCell);
    return row;
  }

  /** 项目表格。 */
  function renderTable(visibleProjects) {
    const container = createElement('div', 'table-container');
    const table = createElement('table', 'project-table');
    table.setAttribute('aria-label', PAGE_TITLE);

    const head = document.createElement('thead');
    const headRow = document.createElement('tr');
    const headings = [
      ['项目名称', ''],
      ['视觉风格', ''],
      ['作品数', 'column-number'],
      ['资产数', 'column-number'],
      ['更新时间', ''],
      ['操作', 'column-actions']
    ];
    for (const [text, className] of headings) {
      const cell = createElement('th', className, text);
      cell.scope = 'col';
      headRow.append(cell);
    }
    head.append(headRow);

    const body = document.createElement('tbody');
    for (const project of visibleProjects) body.append(renderRow(project));
    table.append(head, body);
    container.append(table);
    return container;
  }

  /** 空状态、加载中和错误状态。 */
  function renderState(text, button) {
    const state = createElement('div', 'list-state');
    state.append(createElement('p', 'description', text));
    if (button) state.append(button);
    return state;
  }

  /** 按当前状态刷新内容区。 */
  function renderContent() {
    contentElement.textContent = '';
    if (isLoading) {
      contentElement.append(renderState('加载中…'));
      return;
    }
    if (loadError) {
      contentElement.append(renderState(loadError, createButton('重试', 'button', () => void loadProjects())));
      return;
    }
    if (projects.length === 0) {
      contentElement.append(renderState('还没有项目。', createButton('创建项目', 'button button-primary', () => void runAction(REQUEST_CREATE))));
      return;
    }

    const keyword = filterText.trim().toLowerCase();
    const visibleProjects = projects.filter((project) => project.name.toLowerCase().includes(keyword));
    if (visibleProjects.length === 0) {
      contentElement.append(renderState('没有匹配的项目。'));
      return;
    }
    contentElement.append(renderTable(visibleProjects));
  }

  /** 渲染页面骨架。 */
  function renderPage() {
    const title = createElement('h1', '', PAGE_TITLE);

    const toolbar = createElement('div', 'list-toolbar');
    const search = createElement('input', 'field-input');
    search.type = 'search';
    search.placeholder = '搜索项目名称';
    search.setAttribute('aria-label', '搜索项目名称');
    search.addEventListener('input', () => {
      filterText = search.value;
      renderContent();
    });
    toolbar.append(search, createButton('创建项目', 'button button-primary', () => void runAction(REQUEST_CREATE)));

    messageElement = createElement('p', 'list-message');
    messageElement.setAttribute('role', 'status');
    messageElement.hidden = true;
    contentElement = createElement('div');

    root.append(title, toolbar, messageElement, contentElement);
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, () => void loadProjects());
  void loadProjects();
})();
