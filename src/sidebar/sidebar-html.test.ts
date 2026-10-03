// ------------------------------------------------------------------------
// 名称：sidebar-html.test.ts
// 说明：侧栏页面 HTML 与降级菜单的自动化测试：提示的渲染与转义、降级菜单只保留数据备份入口且可点击处理。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageRouter } from '../app/messaging/message-router';
import { SidebarActionRegistry } from './sidebar-actions';
import { createSidebarHtml } from './sidebar-html';
import { SIDEBAR_REQUESTS, registerSidebarHandlers } from './sidebar-handlers';
import { DATABASE_UNAVAILABLE_NOTICE_PREFIX, DEGRADED_SIDEBAR_SECTIONS, SIDEBAR_SECTIONS } from './sidebar-menu-config';

const BASE_OPTIONS = { cspSource: 'vscode-resource:', styleUris: ['a.css'], scriptUris: ['a.js'] };

test('没有提示时不渲染提示卡片', () => {
  const html = createSidebarHtml({ ...BASE_OPTIONS, sections: SIDEBAR_SECTIONS });
  assert.ok(!html.includes('class="notice"'));
});

test('有提示时渲染在菜单上方，带 alert 角色，并转义 HTML', () => {
  const notice = `${DATABASE_UNAVAILABLE_NOTICE_PREFIX}无法解析 <script>alert(1)</script> & "文件"`;
  const html = createSidebarHtml({ ...BASE_OPTIONS, sections: DEGRADED_SIDEBAR_SECTIONS, notice });

  assert.match(html, /<p class="notice" role="alert">数据库无法打开：/);
  assert.ok(!html.includes('<script>alert(1)'), '提示中的标记必须被转义');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;文件&quot;'));
  assert.ok(html.indexOf('class="notice"') < html.indexOf('class="menu-row"'), '提示在菜单之前');
});

test('降级菜单：只有数据备份（恢复）一个入口，没有尾部操作，条目标识与完整菜单中的数据备份一致', () => {
  const items = DEGRADED_SIDEBAR_SECTIONS.flatMap((section) => section.items);
  assert.deepEqual(items, [{ id: 'data-backup', title: '数据备份（恢复）' }]);

  const fullMenuItem = SIDEBAR_SECTIONS.flatMap((section) => section.items).find((item) => item.id === 'data-backup');
  assert.ok(fullMenuItem !== undefined, '完整菜单中存在同一个条目');
  assert.equal(createSidebarHtml({ ...BASE_OPTIONS, sections: DEGRADED_SIDEBAR_SECTIONS }).split('menu-row').length - 1, 1);
});

test('降级菜单：点击数据备份入口由注册的动作处理，其他入口不存在', async () => {
  let opened = 0;
  const registry = new SidebarActionRegistry(DEGRADED_SIDEBAR_SECTIONS).register('data-backup', 'main', () => void (opened += 1));
  const router = new MessageRouter();
  registerSidebarHandlers(router, registry);
  const click = (itemId: string) => router.handle({ type: 'request', requestId: 1, name: SIDEBAR_REQUESTS.open, payload: { itemId, target: 'main' } });

  const handled = await click('data-backup');
  assert.ok(handled?.ok && (handled.data as { handled: boolean }).handled);
  assert.equal(opened, 1);

  const other = await click('project-list');
  assert.ok(other?.ok && !(other.data as { handled: boolean }).handled, '降级菜单没有其他入口，点击视为尚未开放');
  assert.throws(() => registry.register('project-list', 'main', () => undefined), /不存在菜单行/);
});