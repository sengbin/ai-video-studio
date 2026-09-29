// ------------------------------------------------------------------------
// 名称：sidebar-html.ts
// 说明：侧栏页面的 HTML 标记生成，按菜单配置渲染分区与菜单行。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：样式与脚本位于 resources/sidebar，由外部文件引用。
// ------------------------------------------------------------------------

import { randomBytes } from 'crypto';
import { SidebarMenuItem, SidebarMenuSection } from './sidebar-menu-config';

/** 生成侧栏 HTML 所需的输入。 */
export interface SidebarHtmlOptions {
  /** Webview 的 CSP 来源，用于放行外部样式文件。 */
  readonly cspSource: string;
  readonly styleUri: string;
  readonly scriptUri: string;
  readonly sections: readonly SidebarMenuSection[];
}

/**
 * 生成侧栏页面的完整 HTML。
 * @param options 资源地址与菜单分区。
 * @returns 可直接赋给 Webview 的 HTML 字符串。
 */
export function createSidebarHtml(options: SidebarHtmlOptions): string {
  const nonce = randomBytes(16).toString('hex');
  const sectionsHtml = options.sections.map(renderSection).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
</head>
<body>
  <main>
${sectionsHtml}
  </main>
  <script nonce="${nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>`;
}

/** 渲染一个分区卡片及其菜单行。 */
function renderSection(section: SidebarMenuSection): string {
  const headingId = `section-heading-${section.id}`;
  const rows = section.items.map(renderItem).join('\n');
  return `    <section class="card" aria-labelledby="${headingId}">
      <div class="card-inner card-${section.surface}">
        <h2 id="${headingId}">${escapeHtml(section.title)}</h2>
        <nav aria-label="${escapeHtml(section.title)}">
${rows}
        </nav>
      </div>
    </section>`;
}

/** 渲染一个菜单行：主入口按钮，以及可选的尾部操作按钮。 */
function renderItem(item: SidebarMenuItem): string {
  const title = escapeHtml(item.title);
  const actionHtml = item.actionLabel === undefined
    ? ''
    : `\n            <button class="menu-action" type="button" aria-label="${escapeHtml(`${item.actionLabel}：${item.title}`)}">${escapeHtml(item.actionLabel)}</button>`;
  return `          <div class="menu-row" data-item-id="${escapeHtml(item.id)}">
            <button class="menu-main" type="button" title="${title}">${title}</button>${actionHtml}
          </div>`;
}

/** 转义写入 HTML 文本和属性值的字符。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
