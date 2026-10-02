// ------------------------------------------------------------------------
// 名称：page-html.ts
// 说明：生成编辑器区 Webview 页面的 HTML 外壳：CSP、顶部标题栏（页面名称、描述与右侧工具栏插槽）、样式与脚本引用和挂载点。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：页面内容由脚本渲染到 #app，不在 HTML 中内联数据或样式；标题栏由宿主渲染，页面脚本不再自己显示页面标题，搜索框、筛选等工具控件放进 #page-toolbar。
// ------------------------------------------------------------------------

import { createNonce, escapeHtml } from './html-utils';

/** 生成页面 HTML 所需的输入。 */
export interface PageHtmlOptions {
  /** 页面名称，与标签页标题一致，显示在顶部标题栏。 */
  readonly title: string;
  /** 页面描述，显示在标题后面。 */
  readonly description: string;
  /** Webview 的 CSP 来源。 */
  readonly cspSource: string;
  /** 样式文件的 Webview 地址，按顺序引用。 */
  readonly styleUris: readonly string[];
  /** 脚本文件的 Webview 地址，按顺序执行。 */
  readonly scriptUris: readonly string[];
}

/**
 * 生成页面的完整 HTML。
 * @param options 标题与资源地址。
 */
export function createPageHtml(options: PageHtmlOptions): string {
  const nonce = createNonce();
  const styleTags = options.styleUris.map((uri) => `  <link rel="stylesheet" href="${escapeHtml(uri)}">`).join('\n');
  const scriptTags = options.scriptUris
    .map((uri) => `  <script nonce="${nonce}" src="${escapeHtml(uri)}"></script>`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${options.cspSource}; img-src data:; media-src data:; script-src 'nonce-${nonce}';">
  <title>${escapeHtml(options.title)}</title>
${styleTags}
</head>
<body>
  <header class="page-header">
    <div class="page-header__text">
      <h1 class="page-header__title">${escapeHtml(options.title)}</h1>
      <p class="page-header__description">${escapeHtml(options.description)}</p>
    </div>
    <div id="page-toolbar" class="page-header__toolbar"></div>
  </header>
  <div id="app"></div>
${scriptTags}
</body>
</html>`;
}
