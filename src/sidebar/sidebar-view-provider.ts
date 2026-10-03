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
import { connectWebviewMessaging } from '../app/panels/webview-messaging';
import { getWebviewResourceRoots, toWebviewResourceUri } from '../app/panels/webview-resources';
import { createSidebarHtml } from './sidebar-html';
import { SIDEBAR_SECTIONS, SidebarMenuSection } from './sidebar-menu-config';

/** 侧栏视图标识，需与 package.json 中 views 的 id 一致。 */
export const SIDEBAR_VIEW_ID = 'aigcVideoStudio.sidebar';

/** 侧栏要显示的内容：菜单分区，以及可选的提示。 */
export interface SidebarContent {
  readonly sections: readonly SidebarMenuSection[];
  /** 显示在菜单上方的提示，如数据库无法打开的原因；缺省不显示。 */
  readonly notice?: string;
}

/** 提供侧栏 Webview 视图。 */
export class SidebarViewProvider implements vscode.WebviewViewProvider {
  /**
   * @param extensionUri 扩展安装目录 URI，用于定位静态资源。
   * @param router 处理侧栏点击请求的路由器。
   * @param content 侧栏内容，缺省为完整菜单；数据库无法打开时传入降级菜单与提示。
   */
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly router: MessageRouter,
    private readonly content: SidebarContent = { sections: SIDEBAR_SECTIONS }
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
      sections: this.content.sections,
      notice: this.content.notice
    });
    // 视图销毁（如侧栏被隐藏后回收）时释放消息订阅并停止回复，见 webview-messaging.ts。
    connectWebviewMessaging(webview, view, this.router);
  }
}