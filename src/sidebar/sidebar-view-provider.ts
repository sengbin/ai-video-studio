// ------------------------------------------------------------------------
// 名称：sidebar-view-provider.ts
// 说明：侧栏 Webview 视图提供者，负责创建并渲染侧栏页面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：当前只提供页面展示，不处理任何 Webview 消息。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { createSidebarHtml } from './sidebar-html';
import { SIDEBAR_SECTIONS } from './sidebar-menu-config';

/** 侧栏视图标识，需与 package.json 中 views 的 id 一致。 */
export const SIDEBAR_VIEW_ID = 'aiVideoStudio.sidebar';

/** 侧栏页面的静态资源目录（相对扩展根目录）。 */
const SIDEBAR_RESOURCE_PATH = ['resources', 'sidebar'] as const;
const SIDEBAR_STYLE_FILE = 'sidebar.css';
const SIDEBAR_SCRIPT_FILE = 'sidebar.js';

/** 提供侧栏 Webview 视图。 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  /**
   * @param extensionUri 扩展安装目录 URI，用于定位静态资源。
   */
  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * 解析侧栏视图并写入页面内容。
   * @param view VS Code 创建的 Webview 视图。
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    const resourceRoot = vscode.Uri.joinPath(this.extensionUri, ...SIDEBAR_RESOURCE_PATH);
    const webview = view.webview;
    webview.options = { enableScripts: true, localResourceRoots: [resourceRoot] };
    webview.html = createSidebarHtml({
      cspSource: webview.cspSource,
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, SIDEBAR_STYLE_FILE)).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(resourceRoot, SIDEBAR_SCRIPT_FILE)).toString(),
      sections: SIDEBAR_SECTIONS
    });
  }
}
