// ------------------------------------------------------------------------
// 名称：extension.ts
// 说明：AI Video Studio（智影）扩展入口，负责激活时装配数据库、服务、页面与侧栏。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：入口只做装配，业务逻辑位于 app、domain、infra 目录。
// ------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';
import * as vscode from 'vscode';
import { MessageRouter } from './app/messaging/message-router';
import { ProjectPages } from './app/pages/project-pages';
import { PanelManager } from './app/panels/panel-manager';
import { ProjectService } from './app/services/project-service';
import { openDatabase } from './infra/database/database-connection';
import { SqliteProjectRepository } from './infra/database/sqlite-project-repository';
import { SidebarActionRegistry } from './sidebar/sidebar-actions';
import { registerSidebarHandlers } from './sidebar/sidebar-handlers';
import { SIDEBAR_SECTIONS } from './sidebar/sidebar-menu-config';
import { SIDEBAR_VIEW_ID, SidebarViewProvider } from './sidebar/sidebar-view-provider';

/** 数据库文件名，位于扩展的全局存储目录。 */
const DATABASE_FILE_NAME = 'ai-video-studio.sqlite';

/**
 * 激活扩展：打开数据库并升级结构，装配服务与页面，注册侧栏视图。
 * @param context 扩展上下文，用于登记需要随扩展释放的资源。
 */
export function activate(context: vscode.ExtensionContext): void {
  const database = openDatabaseOrReport(context);
  if (database === undefined) {
    return;
  }
  context.subscriptions.push({ dispose: () => database.close() });

  const projectService = new ProjectService(new SqliteProjectRepository(database));
  const panels = new PanelManager(context.extensionUri);
  const projectPages = new ProjectPages(projectService, panels);

  const actionRegistry = new SidebarActionRegistry(SIDEBAR_SECTIONS)
    .register('project-list', 'main', () => projectPages.showProjectList())
    .register('project-list', 'action', () => projectPages.showCreateForm());
  const sidebarRouter = new MessageRouter();
  registerSidebarHandlers(sidebarRouter, actionRegistry);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SIDEBAR_VIEW_ID,
      new SidebarViewProvider(context.extensionUri, sidebarRouter)
    )
  );
}

/** 停用扩展；注册的资源由 VS Code 通过 subscriptions 统一释放。 */
export function deactivate(): void {}

/**
 * 在全局存储目录中打开数据库；失败时提示用户并返回 undefined。
 * @param context 扩展上下文。
 */
function openDatabaseOrReport(context: vscode.ExtensionContext): ReturnType<typeof openDatabase> | undefined {
  try {
    mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    return openDatabase(vscode.Uri.joinPath(context.globalStorageUri, DATABASE_FILE_NAME).fsPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AI Video Studio 无法打开数据库：${detail}`);
    return undefined;
  }
}
