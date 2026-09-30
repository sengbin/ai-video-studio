// ------------------------------------------------------------------------
// 名称：sidebar-handlers.ts
// 说明：侧栏的请求处理：接收菜单点击并交给动作注册表，返回是否已处理，未处理的入口由页面提示“尚未开放”。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求名称需与 resources/sidebar/sidebar.js 一致；不依赖 VS Code。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../domain/errors';
import { readRecord } from '../domain/rules/field-readers';
import { MessageRouter } from '../app/messaging/message-router';
import { SIDEBAR_TARGETS, SidebarActionRegistry, SidebarTarget } from './sidebar-actions';

/** 侧栏使用的请求名称。 */
export const SIDEBAR_REQUESTS = {
  open: 'sidebar.open'
} as const;

/**
 * 在路由器上注册侧栏点击的处理函数。
 * @param router 侧栏的请求路由器。
 * @param registry 动作注册表。
 */
export function registerSidebarHandlers(router: MessageRouter, registry: SidebarActionRegistry): void {
  router.register(SIDEBAR_REQUESTS.open, (payload) => {
    const source = readRecord(payload);
    const itemId = source.itemId;
    const target = source.target;
    if (typeof itemId !== 'string' || !isSidebarTarget(target)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '菜单点击参数无效。' });
    }

    return { handled: registry.run(itemId, target) };
  });
}

/** 判断值是否为合法的点击位置。 */
function isSidebarTarget(value: unknown): value is SidebarTarget {
  return SIDEBAR_TARGETS.some((target) => target === value);
}
