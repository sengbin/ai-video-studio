// ------------------------------------------------------------------------
// 名称：sidebar-actions.ts
// 说明：侧栏点击动作注册表：把“菜单行 + 点击位置”映射到具体动作，并按菜单配置校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：未注册动作的入口视为功能尚未开放；不依赖 VS Code。
// ------------------------------------------------------------------------

import { SidebarMenuItem, SidebarMenuSection } from './sidebar-menu-config';

/** 点击位置：主入口或尾部操作。 */
export type SidebarTarget = 'main' | 'action';

/** 全部合法的点击位置。 */
export const SIDEBAR_TARGETS: readonly SidebarTarget[] = ['main', 'action'];

/** 侧栏动作注册表。 */
export class SidebarActionRegistry {
  private readonly items = new Map<string, SidebarMenuItem>();
  private readonly handlers = new Map<string, () => void>();

  /**
   * @param sections 菜单配置，注册的动作必须对应其中存在的菜单行。
   */
  constructor(sections: readonly SidebarMenuSection[]) {
    for (const section of sections) {
      for (const item of section.items) {
        this.items.set(item.id, item);
      }
    }
  }

  /**
   * 注册菜单行某个位置的点击动作。
   * @param itemId 菜单行 id。
   * @param target 点击位置；尾部操作要求该行配置了尾部操作。
   * @param handler 点击时执行的动作。
   * @throws Error 菜单行不存在、没有尾部操作或重复注册。
   */
  register(itemId: string, target: SidebarTarget, handler: () => void): this {
    const item = this.items.get(itemId);
    if (item === undefined) {
      throw new Error(`侧栏菜单中不存在菜单行 ${itemId}。`);
    }
    if (target === 'action' && item.actionLabel === undefined) {
      throw new Error(`菜单行 ${itemId} 没有尾部操作。`);
    }
    const key = toKey(itemId, target);
    if (this.handlers.has(key)) {
      throw new Error(`菜单行 ${itemId} 的 ${target} 已注册动作。`);
    }
    this.handlers.set(key, handler);
    return this;
  }

  /**
   * 执行点击动作。
   * @returns 是否有已注册的动作并已执行。
   */
  run(itemId: string, target: SidebarTarget): boolean {
    const handler = this.handlers.get(toKey(itemId, target));
    if (handler === undefined) {
      return false;
    }
    handler();
    return true;
  }
}

/** 动作在注册表中的键。 */
function toKey(itemId: string, target: SidebarTarget): string {
  return `${itemId}:${target}`;
}
