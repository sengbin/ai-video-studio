// ------------------------------------------------------------------------
// 名称：page-resources.ts
// 说明：各 Webview 页面使用的样式与脚本清单：界面组件库（ui-kit/src）的文件按依赖顺序集中在此引用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：路径相对扩展根目录，使用 / 分隔；组件库顺序须与 ui-kit/manifest.json 一致（测试校验）；不依赖 VS Code。
// ------------------------------------------------------------------------

/** 一个页面需要加载的样式与脚本，按加载顺序排列。 */
export interface PageResources {
  readonly styles: readonly string[];
  readonly scripts: readonly string[];
}

/** 界面组件库源码目录（相对扩展根目录）。 */
const UI_KIT_DIR = 'ui-kit/src';

/** Webview 允许加载资源的目录（相对扩展根目录）；下面清单中的文件都必须位于其中，测试会检查。 */
export const WEBVIEW_ROOT_PATHS = ['resources', UI_KIT_DIR] as const;

/** 界面组件库的令牌样式，其他样式依赖它，必须最先加载。 */
const UI_TOKENS_STYLE = `${UI_KIT_DIR}/ui-tokens.css`;
/** 编辑器区页面的基础样式（页面外观、标题、状态文字）。 */
const EDITOR_PAGE_THEME_STYLE = 'resources/shared/theme.css';
/** 界面组件库的控件、表格、对话框与滚动条样式。 */
const UI_COMPONENT_STYLES = ['ui-controls.css', 'ui-file-picker.css', 'ui-table.css', 'ui-dialog.css', 'ui-scrollbar.css'].map((name) => `${UI_KIT_DIR}/${name}`);

/** 通信桥与界面组件库的脚本，按依赖顺序排列。 */
const UI_LIBRARY_SCRIPTS = [
  'resources/shared/host-bridge.js',
  ...[
    'ui-core.js',
    'ui-scrollbar.js',
    'ui-button.js',
    'ui-input-controls.js',
    'ui-select.js',
    'ui-choice-controls.js',
    'ui-field.js',
    'ui-table.js',
    'ui-dialog.js',
    'ui-file-picker.js'
  ].map((name) => `${UI_KIT_DIR}/${name}`)
];

/** 把相对 resources 目录的路径转换为相对扩展根目录的路径。 */
function toResourcePath(path: string): string {
  return `resources/${path}`;
}

/**
 * 组装编辑器区页面的资源：组件库在前，页面自己的样式和脚本在后。
 * @param pageStyles 页面自己的样式，相对 resources 目录。
 * @param pageScripts 页面自己的脚本，相对 resources 目录。
 */
function createEditorPageResources(pageStyles: readonly string[], pageScripts: readonly string[]): PageResources {
  return {
    styles: [UI_TOKENS_STYLE, EDITOR_PAGE_THEME_STYLE, ...UI_COMPONENT_STYLES, ...pageStyles.map(toResourcePath)],
    scripts: [...UI_LIBRARY_SCRIPTS, ...pageScripts.map(toResourcePath)]
  };
}

/** 项目列表页：新建与编辑表单在页内弹出，因此一并加载表单引擎。 */
export const PROJECT_LIST_PAGE_RESOURCES: PageResources = createEditorPageResources(
  ['form/form.css', 'project-list/project-list.css'],
  ['form/form-runtime.js', 'shared/page-format.js', 'project-list/project-list.js']
);

/** 作品列表页：新建、编辑、重新生成、生成剧本表单和各阶段产出层都在页内弹出，因此一并加载表单引擎与产出层。 */
export const WORK_LIST_PAGE_RESOURCES: PageResources = createEditorPageResources(
  ['form/form.css', 'stage/stage.css', 'work-list/work-list.css'],
  [
    'form/form-runtime.js',
    'shared/page-format.js',
    'stage/stage.js',
    'stage/stage-creative.js',
    'stage/stage-screenplay.js',
    'stage/stage-storyboard.js',
    'work-list/work-list.js'
  ]
);

/** 资产列表页：新建与编辑表单在页内弹出，因此一并加载表单引擎；生成图片（音频）与版本层在列表脚本之前加载。 */
export const ASSET_LIST_PAGE_RESOURCES: PageResources = createEditorPageResources(
  ['form/form.css', 'asset-list/asset-list.css'],
  ['form/form-runtime.js', 'shared/page-format.js', 'asset-list/asset-generate.js', 'asset-list/asset-versions.js', 'asset-list/asset-list.js']
);

/** 生成工作台页：镜头的编辑与分镜脚本确认复用阶段产出层，因此一并加载表单引擎与分镜脚本产出层；实体绑定页由 bindings.js 提供，生成参数页由 profile.js 提供，尾帧截取由 tail-frames.js 提供。 */
export const WORKBENCH_PAGE_RESOURCES: PageResources = createEditorPageResources(
  ['form/form.css', 'stage/stage.css', 'workbench/workbench.css'],
  ['form/form-runtime.js', 'shared/page-format.js', 'stage/stage.js', 'stage/stage-storyboard.js', 'workbench/bindings.js', 'workbench/profile.js', 'workbench/tail-frames.js', 'workbench/workbench.js']
);

/** 模型设置页：设置即时保存，没有弹出表单。 */
export const SETTINGS_PAGE_RESOURCES: PageResources = createEditorPageResources(['settings/settings.css'], ['settings/settings.js']);

/** 侧栏页面：有自己的布局，不加载编辑器区的基础样式。 */
export const SIDEBAR_PAGE_RESOURCES: PageResources = {
  styles: [UI_TOKENS_STYLE, ...UI_COMPONENT_STYLES, toResourcePath('sidebar/sidebar.css')],
  scripts: [...UI_LIBRARY_SCRIPTS, toResourcePath('sidebar/sidebar.js')]
};
