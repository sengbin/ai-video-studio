// ------------------------------------------------------------------------
// 名称：extension.ts
// 说明：AI Video Studio（智影）扩展入口，负责扩展的激活与停用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：无
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { SIDEBAR_VIEW_ID, SidebarViewProvider } from './sidebar/sidebar-view-provider';

/**
 * 激活扩展并注册侧栏视图。
 * @param context 扩展上下文，用于登记需要随扩展释放的资源。
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new SidebarViewProvider(context.extensionUri))
  );
}

/** 停用扩展；注册的资源由 VS Code 通过 subscriptions 统一释放。 */
export function deactivate(): void {}
