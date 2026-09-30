// ------------------------------------------------------------------------
// 名称：ui-table.test.mjs
// 说明：界面组件库数据表格的 DOM 测试：表头与行渲染、列类型、空值占位、淡色、悬停提示、重设行数据，以及主副文本单元格与标签。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用 jsdom；无排版，只验证结构、属性和类名，不验证视觉。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createUiEnvironment } from './ui-environment.mjs';

let env;

/** 每个用例使用全新的页面，结束后释放。 */
function setup() {
  env = createUiEnvironment();
  return { ui: env.aiUi, doc: env.document };
}

afterEach(() => env?.close());

test('表格：渲染带 scope 的表头与每行的单元格，并带可访问名称', () => {
  const { ui } = setup();
  const table = ui.table({
    ariaLabel: '全部项目',
    columns: [{ title: '名称', key: 'name' }, { title: '数量', key: 'count', type: 'number' }],
    rows: [{ name: '甲', count: 3 }, { name: '乙', count: 0 }]
  });
  const root = table.element.querySelector('table.ui-table');
  assert.equal(root.getAttribute('aria-label'), '全部项目');
  assert.deepEqual([...root.querySelectorAll('th')].map((cell) => [cell.textContent, cell.getAttribute('scope')]), [
    ['名称', 'col'],
    ['数量', 'col']
  ]);
  const rows = [...root.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 2);
  assert.deepEqual([...rows[0].children].map((cell) => cell.textContent), ['甲', '3']);
  assert.equal(rows[1].children[1].textContent, '0', '数字 0 应显示，不当作空值');
});

test('表格：数字列与操作列的表头、内容单元格都带对应类名，nowrap 生效', () => {
  const { ui } = setup();
  const table = ui.table({
    columns: [
      { title: '数量', key: 'count', type: 'number' },
      { title: '操作', type: 'actions', render: () => 'x' },
      { title: '时间', key: 'time', nowrap: true }
    ],
    rows: [{ count: 1, time: '刚刚' }]
  });
  for (const selector of ['th', 'td']) {
    const cells = table.element.querySelectorAll(selector);
    assert.ok(cells[0].classList.contains('ui-table__cell--number'));
    assert.ok(cells[1].classList.contains('ui-table__cell--actions'));
    assert.ok(cells[2].classList.contains('ui-table__cell--nowrap'));
  }
});

test('表格：列宽设在表头上，数字按像素、字符串原样', () => {
  const { ui } = setup();
  const table = ui.table({
    columns: [{ title: 'A', key: 'a', width: '34%', minWidth: 180 }, { title: 'B', key: 'b', width: 110 }],
    rows: []
  });
  const heads = table.element.querySelectorAll('th');
  assert.equal(heads[0].style.width, '34%');
  assert.equal(heads[0].style.minWidth, '180px');
  assert.equal(heads[1].style.width, '110px');
});

test('表格：render 可返回节点、文本或节点数组，空值显示 emptyText 占位', () => {
  const { ui } = setup();
  const table = ui.table({
    columns: [
      { title: '标签', key: 'tag', emptyText: '未设置', render: (row) => row.tag && ui.chip({ text: row.tag }) },
      { title: '操作', render: () => [ui.button({ text: '一' }).element, ui.button({ text: '二' }).element] }
    ],
    rows: [{ tag: '写实摄影' }, { tag: '' }]
  });
  const rows = table.element.querySelectorAll('tbody tr');
  assert.equal(rows[0].querySelector('.ui-chip').textContent, '写实摄影');
  assert.equal(rows[0].querySelectorAll('button').length, 2);
  const placeholder = rows[1].children[0].querySelector('.ui-is-muted');
  assert.equal(placeholder.textContent, '未设置');
  assert.equal(rows[1].querySelector('.ui-chip'), null);
});

test('表格：muted 支持布尔值与函数，tooltip 写入单元格 title', () => {
  const { ui } = setup();
  const table = ui.table({
    columns: [
      { title: '数量', key: 'count', muted: (row) => row.count === 0 },
      { title: '时间', key: 'time', muted: true, tooltip: (row) => `完整：${row.time}` }
    ],
    rows: [{ count: 0, time: 'a' }, { count: 2, time: 'b' }]
  });
  const rows = table.element.querySelectorAll('tbody tr');
  assert.ok(rows[0].children[0].classList.contains('ui-is-muted'));
  assert.ok(!rows[1].children[0].classList.contains('ui-is-muted'));
  assert.ok(rows[1].children[1].classList.contains('ui-is-muted'));
  assert.equal(rows[1].children[1].getAttribute('title'), '完整：b');
  assert.equal(rows[0].children[0].getAttribute('title'), null);
});

test('表格：setRows 整体替换表体，getRows 返回当前行的副本', () => {
  const { ui } = setup();
  const table = ui.table({ columns: [{ title: '名称', key: 'name' }], rows: [{ name: '甲' }] });
  table.setRows([{ name: '乙' }, { name: '丙' }]);
  assert.deepEqual([...table.element.querySelectorAll('tbody td')].map((cell) => cell.textContent), ['乙', '丙']);
  assert.equal(table.getRows().length, 2);
  table.getRows().pop();
  assert.equal(table.getRows().length, 2, '修改返回值不应影响表格');
  table.setRows([]);
  assert.equal(table.element.querySelectorAll('tbody tr').length, 0);
});

test('表格：列描述有误时立即报错', () => {
  const { ui } = setup();
  assert.throws(() => ui.table({ columns: [] }), /至少需要一列/);
  assert.throws(() => ui.table({ columns: [{ key: 'a' }] }), /必须有 title/);
  assert.throws(() => ui.table({ columns: [{ title: 'A', key: 'a', type: 'money' }] }), /未知的表格列类型/);
  assert.throws(() => ui.table({ columns: [{ title: 'A' }] }), /需要 key 或 render/);
});

test('表格：文本按文本写入，不解析为 HTML', () => {
  const { ui } = setup();
  const table = ui.table({ columns: [{ title: '名称', key: 'name' }], rows: [{ name: '<img src=x onerror=alert(1)>' }] });
  assert.equal(table.element.querySelector('tbody img'), null);
  assert.equal(table.element.querySelector('tbody td').textContent, '<img src=x onerror=alert(1)>');
});

test('主副文本单元格：说明为空时不出现，有说明时带悬停全文', () => {
  const { ui } = setup();
  const plain = ui.tableMainCell({ text: '灯塔计划' });
  assert.equal(plain.querySelector('.ui-table__title').textContent, '灯塔计划');
  assert.equal(plain.querySelector('.ui-table__description'), null);

  const detailed = ui.tableMainCell({ text: '灯塔计划', description: '一部短片' });
  const description = detailed.querySelector('.ui-table__description');
  assert.equal(description.textContent, '一部短片');
  assert.equal(description.getAttribute('title'), '一部短片');
});

test('标签：显示文本并带 ui-chip 类', () => {
  const { ui } = setup();
  const chip = ui.chip({ text: '写实摄影' });
  assert.equal(chip.textContent, '写实摄影');
  assert.ok(chip.classList.contains('ui-chip'));
});
