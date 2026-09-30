// ------------------------------------------------------------------------
// 名称：page-resources.ts
// 说明：各 Webview 页面使用的样式与脚本清单：界面组件库文件按依赖顺序集中在此维护。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：路径相对 resources 目录，使用 / 分隔；不依赖 VS Code，测试会校验文件均存在。
// ------------------------------------------------------------------------

/** 一个页面需要加载的样式与脚本，按加载顺序排列。 */
export interface PageResources {
  readonly styles: readonly string[];
  readonly scripts: readonly string[];
}

/** 界面组件库的令牌样式，其他样式依赖它，必须最先加载。 */
const UI_TOKENS_STYLE = 'shared/ui/ui-tokens.css';
/** 编辑器区页面的基础样式（页面外观、标题、状态文字）。 */
const EDITOR_PAGE_THEME_STYLE = 'shared/theme.css';
/** 界面组件库的控件、对话框与滚动条样式。 */
const UI_COMPONENT_STYLES = ['shared/ui/ui-controls.css', 'shared/ui/ui-dialog.css', 'shared/ui/ui-scrollbar.css'] as const;

/** 通信桥与界面组件库的脚本，按依赖顺序排列：核心先于其他组件。 */
const UI_LIBRARY_SCRIPTS = [
  'shared/host-bridge.js',
  'shared/ui/ui-core.js',
  'shared/ui/ui-scrollbar.js',
  'shared/ui/ui-button.js',
  'shared/ui/ui-input-controls.js',
  'shared/ui/ui-select.js',
  'shared/ui/ui-choice-controls.js',
  'shared/ui/ui-field.js',
  'shared/ui/ui-dialog.js'
] as const;

/**
 * 组装编辑器区页面的资源：组件库在前，页面自己的样式和脚本在后。
 * @param pageStyles 页面自己的样式。
 * @param pageScripts 页面自己的脚本。
 */
function createEditorPageResources(pageStyles: readonly string[], pageScripts: readonly string[]): PageResources {
  return {
    styles: [UI_TOKENS_STYLE, EDITOR_PAGE_THEME_STYLE, ...UI_COMPONENT_STYLES, ...pageStyles],
    scripts: [...UI_LIBRARY_SCRIPTS, ...pageScripts]
  };
}

/** 表单页面。 */
export const FORM_PAGE_RESOURCES: PageResources = createEditorPageResources(['form/form.css'], ['form/form-runtime.js']);

/** 项目列表页。 */
export const PROJECT_LIST_PAGE_RESOURCES: PageResources = createEditorPageResources(
  ['project-list/project-list.css'],
  ['project-list/project-list.js']
);

/** 侧栏页面：有自己的布局，不加载编辑器区的基础样式。 */
export const SIDEBAR_PAGE_RESOURCES: PageResources = {
  styles: [UI_TOKENS_STYLE, ...UI_COMPONENT_STYLES, 'sidebar/sidebar.css'],
  scripts: [...UI_LIBRARY_SCRIPTS, 'sidebar/sidebar.js']
};
