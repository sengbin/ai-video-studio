// ------------------------------------------------------------------------
// 名称：sidebar-handlers.test.ts
// 说明：侧栏动作注册表与点击请求处理的自动化测试，并校验菜单配置自身的一致性。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code 环境。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageRouter } from '../app/messaging/message-router';
import { SidebarActionRegistry } from './sidebar-actions';
import { SIDEBAR_REQUESTS, registerSidebarHandlers } from './sidebar-handlers';
import { SIDEBAR_SECTIONS } from './sidebar-menu-config';

/** 创建路由器和注册表的夹具。 */
function createFixture() {
  const registry = new SidebarActionRegistry(SIDEBAR_SECTIONS);
  const router = new MessageRouter();
  registerSidebarHandlers(router, registry);
  const click = (payload: unknown) =>
    router.handle({ type: 'request', requestId: 1, name: SIDEBAR_REQUESTS.open, payload });
  return { registry, click };
}

test('菜单配置：分区与菜单行 id 全局唯一，尾部操作和标签非空', () => {
  const sectionIds = SIDEBAR_SECTIONS.map((section) => section.id);
  assert.equal(new Set(sectionIds).size, sectionIds.length);

  const itemIds = SIDEBAR_SECTIONS.flatMap((section) => section.items.map((item) => item.id));
  assert.equal(new Set(itemIds).size, itemIds.length);

  for (const item of SIDEBAR_SECTIONS.flatMap((section) => section.items)) {
    assert.ok(item.title.length > 0);
    assert.ok(item.actionLabel === undefined || item.actionLabel.length > 0);
    assert.ok(item.badge === undefined || item.badge.length > 0);
  }
});

test('已注册的动作被执行，点击位置互不影响', async () => {
  const { registry, click } = createFixture();
  const calls: string[] = [];
  registry
    .register('project-list', 'main', () => calls.push('list'))
    .register('project-list', 'action', () => calls.push('create'));

  const main = await click({ itemId: 'project-list', target: 'main' });
  const action = await click({ itemId: 'project-list', target: 'action' });

  assert.deepEqual(main?.ok && main.data, { handled: true });
  assert.deepEqual(action?.ok && action.data, { handled: true });
  assert.deepEqual(calls, ['list', 'create']);
});

test('未注册的入口返回 handled 为 false，由页面提示', async () => {
  const { click } = createFixture();
  const response = await click({ itemId: 'video-workbench', target: 'main' });
  assert.deepEqual(response?.ok && response.data, { handled: false });
});

test('点击参数不合法时返回校验错误', async () => {
  const { click } = createFixture();
  for (const payload of [{ itemId: 1, target: 'main' }, { itemId: 'project-list', target: 'other' }, {}, null]) {
    const response = await click(payload);
    assert.ok(response && !response.ok && response.error.kind === 'validation', JSON.stringify(payload));
  }
});

test('注册动作时校验菜单行、尾部操作和重复注册', () => {
  const registry = new SidebarActionRegistry(SIDEBAR_SECTIONS);
  assert.throws(() => registry.register('no-such-item', 'main', () => undefined), /不存在/);
  assert.throws(() => registry.register('video-workbench', 'action', () => undefined), /没有尾部操作/);
  registry.register('project-list', 'main', () => undefined);
  assert.throws(() => registry.register('project-list', 'main', () => undefined), /已注册/);
});
