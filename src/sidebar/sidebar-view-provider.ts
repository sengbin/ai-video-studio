// ------------------------------------------------------------------------
// 名称：sidebar-view-provider.ts
// 说明：侧栏 Webview 视图提供者，负责创建并渲染侧栏页面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：页面点击经请求路由器分发，具体动作由外部注册。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { MessageRouter } from '../app/messaging/message-router';
import { SIDEBAR_PAGE_RESOURCES } from '../app/panels/page-resources';
import { getWebviewResourceRoots, toWebviewResourceUri } from '../app/panels/webview-resources';
import { createSidebarHtml } from './sidebar-html';
import { SIDEBAR_SECTIONS } from './sidebar-menu-config';

/** 侧栏视图标识，需与 package.json 中 views 的 id 一致。 */
export const SIDEBAR_VIEW_ID = 'aigcVideoStudio.sidebar';

/** 提供侧栏 Webview 视图。 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  /**
   * @param extensionUri 扩展安装目录 URI，用于定位静态资源。
   * @param router 处理侧栏点击请求的路由器。
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly router: MessageRouter
  ) {}

  /**
   * 解析侧栏视图并写入页面内容。
   * @param view VS Code 创建的 Webview 视图。
   */
  resolveWebviewView(view: vscode.WebviewView): void {
    const webview = view.webview;
    const toUri = (relativePath: string): string => toWebviewResourceUri(webview, this.extensionUri, relativePath);
    webview.options = { enableScripts: true, localResourceRoots: getWebviewResourceRoots(this.extensionUri) };
    webview.html = createSidebarHtml({
      cspSource: webview.cspSource,
      styleUris: SIDEBAR_PAGE_RESOURCES.styles.map(toUri),
      scriptUris: SIDEBAR_PAGE_RESOURCES.scripts.map(toUri),
      sections: SIDEBAR_SECTIONS
    });
    webview.onDidReceiveMessage(async (message: unknown) => {
      const response = await this.router.handle(message);
      if (response === undefined) {
        return;
      }
      try {
        await webview.postMessage(response);
      } catch {
        // 回复时视图已销毁，无需处理。
      }
    });
  }
}
