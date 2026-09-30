// ------------------------------------------------------------------------
// 名称：webview-resources.ts
// 说明：Webview 静态资源定位：确定页面可加载的目录，并把资源路径转换为 Webview 可访问的地址。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：编辑器区面板与侧栏共用；资源路径相对扩展根目录，使用 / 分隔。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';

/** 页面允许加载的目录（相对扩展根目录）：页面自己的资源、界面组件库源码。 */
const WEBVIEW_ROOT_PATHS = ['resources', 'ui-kit/src'] as const;

/**
 * 页面允许加载的目录，写入 Webview 的 `localResourceRoots`。
 * @param extensionUri 扩展安装目录 URI。
 */
export function getWebviewResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return WEBVIEW_ROOT_PATHS.map((path) => vscode.Uri.joinPath(extensionUri, ...path.split('/')));
}

/**
 * 把相对扩展根目录的资源路径转换为 Webview 地址。
 * @param webview 目标 Webview。
 * @param extensionUri 扩展安装目录 URI。
 * @param relativePath 资源路径，使用 `/` 分隔。
 */
export function toWebviewResourceUri(webview: vscode.Webview, extensionUri: vscode.Uri, relativePath: string): string {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...relativePath.split('/'))).toString();
}
