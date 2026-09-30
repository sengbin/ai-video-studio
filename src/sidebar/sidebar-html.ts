// ------------------------------------------------------------------------
// 名称：sidebar-html.ts
// 说明：侧栏页面的 HTML 标记生成，按菜单配置渲染分区与菜单行。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：样式与脚本位于 resources 目录，由外部文件引用；清单见 app/panels/page-resources.ts。
// ------------------------------------------------------------------------

import { createNonce, escapeHtml } from '../app/panels/html-utils';
import { SidebarMenuItem, SidebarMenuSection } from './sidebar-menu-config';

/** 生成侧栏 HTML 所需的输入。 */
export interface SidebarHtmlOptions {
  /** Webview 的 CSP 来源，用于放行外部样式文件。 */
  readonly cspSource: string;
  /** 样式文件的 Webview 地址，按顺序引用。 */
  readonly styleUris: readonly string[];
  /** 脚本文件的 Webview 地址，按顺序执行。 */
  readonly scriptUris: readonly string[];
  readonly sections: readonly SidebarMenuSection[];
}

/**
 * 生成侧栏页面的完整 HTML。
 * @param options 资源地址与菜单分区。
 * @returns 可直接赋给 Webview 的 HTML 字符串。
 */
export function createSidebarHtml(options: SidebarHtmlOptions): string {
  const nonce = createNonce();
  const sectionsHtml = options.sections.map(renderSection).join('\n');
  const styleTags = options.styleUris.map((uri) => `  <link rel="stylesheet" href="${escapeHtml(uri)}">`).join('\n');
  const scriptTags = options.scriptUris
    .map((uri) => `  <script nonce="${nonce}" src="${escapeHtml(uri)}"></script>`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; script-src 'nonce-${nonce}';">
${styleTags}
</head>
<body>
  <main>
${sectionsHtml}
  </main>
${scriptTags}
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

/** 渲染一个菜单行：主入口按钮（可带小标签），以及可选的尾部操作按钮。 */
function renderItem(item: SidebarMenuItem): string {
  const title = escapeHtml(item.title);
  const hoverTitle = escapeHtml(item.badge === undefined ? item.title : `${item.title}（${item.badge}）`);
  const badgeHtml = item.badge === undefined
    ? ''
    : `<span class="menu-badge">${escapeHtml(item.badge)}</span>`;
  const actionHtml = item.actionLabel === undefined
    ? ''
    : `\n            <button class="menu-action" type="button" aria-label="${escapeHtml(`${item.actionLabel}：${item.title}`)}">${escapeHtml(item.actionLabel)}</button>`;
  return `          <div class="menu-row" data-item-id="${escapeHtml(item.id)}">
            <button class="menu-main" type="button" title="${hoverTitle}">${title}${badgeHtml}</button>${actionHtml}
          </div>`;
}
