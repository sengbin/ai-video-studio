// ------------------------------------------------------------------------
// 名称：ui-table.js
// 说明：界面组件库的数据表格：按列描述渲染表头与行，并提供“主副文本单元格”和“标签”两个配套元素。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js；行内操作按钮用 ui-button.js 的紧凑按钮；用法见 docs/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  /** 列类型：text 文本（默认）、number 数字（靠右等宽）、actions 操作（左对齐、按钮成组、固定在表格右侧）。 */
  const COLUMN_TYPES = ['text', 'number', 'actions'];

  /** 数字按像素处理，字符串（如 "34%"）原样使用。 */
  function toCssSize(value) {
    return typeof value === 'number' ? `${value}px` : value;
  }

  /** 单元格（表头与内容共用）的类名。 */
  function cellClass(column) {
    const names = ['ui-table__cell'];
    if (column.type && column.type !== 'text') names.push(`ui-table__cell--${column.type}`);
    if (column.nowrap) names.push('ui-table__cell--nowrap');
    return names.join(' ');
  }

  /** 校验列描述，尽早暴露拼写错误。 */
  function checkColumn(column) {
    if (!column || typeof column.title !== 'string') throw new Error('表格列必须有 title');
    if (column.type !== undefined && !COLUMN_TYPES.includes(column.type)) throw new Error(`未知的表格列类型：${column.type}`);
    if (!column.render && !column.key) throw new Error(`表格列“${column.title}”需要 key 或 render`);
  }

  /** 表头单元格。 */
  function renderHeadCell(column) {
    const cell = aiUi.h('th', { class: cellClass(column), text: column.title, attrs: { scope: 'col' } });
    if (column.width !== undefined) cell.style.width = toCssSize(column.width);
    if (column.minWidth !== undefined) cell.style.minWidth = toCssSize(column.minWidth);
    return cell;
  }

  /** 内容单元格：内容为空且有 emptyText 时显示淡色占位文字。 */
  function renderCell(column, row, index) {
    const value = column.render ? column.render(row, index) : row[column.key];
    const isEmpty = value === undefined || value === null || value === '' || value === false;
    const isMuted = typeof column.muted === 'function' ? column.muted(row) : Boolean(column.muted);
    const classNames = isMuted ? `${cellClass(column)} ui-is-muted` : cellClass(column);
    const content = isEmpty ? (column.emptyText ? aiUi.h('span', { class: 'ui-is-muted', text: column.emptyText }) : null) : value;
    return aiUi.h('td', { class: classNames, attrs: { title: column.tooltip ? column.tooltip(row) : undefined } }, content);
  }

  /**
   * 创建数据表格。
   * @param {{ columns: Array<object>, rows?: Array<object>, ariaLabel?: string }} options
   *   columns 列描述，每列：
   *   title 表头文字；key 取值的字段名；render(row, index) 自定义内容（返回节点、文本、数组，或空值）；
   *   type 列类型 text（默认）、number、actions；width、minWidth 列宽（数字为像素，字符串如 "34%"）；
   *   nowrap 内容不换行；muted 淡色显示（布尔值或 (row) => 布尔值）；emptyText 内容为空时显示的淡色文字；
   *   tooltip(row) 单元格的悬停提示；
   *   rows 行数据；ariaLabel 表格的可访问名称。
   * @returns {{ element: HTMLElement, setRows: (rows: Array<object>) => void, getRows: () => Array<object> }}
   */
  aiUi.table = function (options) {
    const settings = options || {};
    const columns = settings.columns || [];
    if (columns.length === 0) throw new Error('表格至少需要一列');
    columns.forEach(checkColumn);

    let currentRows = [];
    const body = aiUi.h('tbody');
    const head = aiUi.h('thead', {}, aiUi.h('tr', {}, columns.map(renderHeadCell)));
    const element = aiUi.h(
      'div',
      { class: 'ui-table-container' },
      aiUi.h('table', { class: 'ui-table', attrs: { 'aria-label': settings.ariaLabel } }, head, body)
    );

    /** 用新的行数据整体重绘表体。 */
    function setRows(rows) {
      currentRows = [...rows];
      body.textContent = '';
      currentRows.forEach((row, index) => {
        body.append(aiUi.h('tr', {}, columns.map((column) => renderCell(column, row, index))));
      });
    }

    setRows(settings.rows || []);
    return { element, setRows, getRows: () => [...currentRows] };
  };

  /**
   * 主副文本单元格内容：加粗的主文本，下方可选一行淡色说明（单行截断，悬停显示全文）。
   * @param {{ text: string, description?: string }} options
   * @returns {HTMLElement}
   */
  aiUi.tableMainCell = function (options) {
    const settings = options || {};
    return aiUi.h(
      'div',
      { class: 'ui-table__main' },
      aiUi.h('span', { class: 'ui-table__title', text: settings.text }),
      settings.description
        ? aiUi.h('div', { class: 'ui-table__description', text: settings.description, attrs: { title: settings.description } })
        : null
    );
  };

  /**
   * 标签：圆角小标签，用于视觉风格、分类等短文本。
   * @param {{ text: string }} options
   * @returns {HTMLElement}
   */
  aiUi.chip = function (options) {
    return aiUi.h('span', { class: 'ui-chip', text: (options || {}).text });
  };
})();
