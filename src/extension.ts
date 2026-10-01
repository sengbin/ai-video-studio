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
import { SettingsPages } from './app/pages/settings-pages';
import { WorkListPages } from './app/pages/work-list-pages';
import { PanelManager } from './app/panels/panel-manager';
import { ChangeNotifier } from './app/services/change-notifier';
import { ProjectService } from './app/services/project-service';
import { ScreenplayService } from './app/services/screenplay-service';
import { StageChange, StageService } from './app/services/stage-service';
import { TextSettingsService } from './app/services/text-settings-service';
import { WorkService } from './app/services/work-service';
import { CreativeWorkflow } from './app/stages/creative-workflow';
import { ScreenplayWorkflow } from './app/stages/screenplay-workflow';
import { StageRunner } from './app/stages/stage-runner';
import { WorkSourceType } from './domain/models/work';
import { CopilotModelCatalog } from './infra/copilot/copilot-model-catalog';
import { CopilotTextGeneration } from './infra/copilot/copilot-text-generation';
import { VsCodeTextGenerationSettings } from './infra/copilot/vscode-text-generation-settings';
import { openDatabase } from './infra/database/database-connection';
import { SqliteProjectRepository } from './infra/database/sqlite-project-repository';
import { SqliteScreenplayRepository } from './infra/database/sqlite-screenplay-repository';
import { SqliteChapterRepository, SqliteStageRunRepository } from './infra/database/sqlite-stage-run-repository';
import { SqliteWorkRepository } from './infra/database/sqlite-work-repository';
import { SqliteWorkSourceReader } from './infra/database/sqlite-work-source-reader';
import { FilePromptTemplates } from './infra/prompts/file-prompt-templates';
import { SidebarActionRegistry } from './sidebar/sidebar-actions';
import { registerSidebarHandlers } from './sidebar/sidebar-handlers';
import { SIDEBAR_SECTIONS } from './sidebar/sidebar-menu-config';
import { SIDEBAR_VIEW_ID, SidebarViewProvider } from './sidebar/sidebar-view-provider';

/** 数据库文件名，位于扩展的全局存储目录。 */
const DATABASE_FILE_NAME = 'ai-video-studio.sqlite';

/** 侧栏创作入口与素材来源的对应关系。 */
const CREATION_ENTRIES: ReadonlyArray<readonly [string, WorkSourceType]> = [
  ['text-inspiration', 'text'],
  ['image-inspiration', 'image'],
  ['novel-adaptation', 'novel']
];

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

  // 存储与外部服务。
  const runs = new SqliteStageRunRepository(database);
  const chapters = new SqliteChapterRepository(database);
  const screenplays = new SqliteScreenplayRepository(database);
  const settingsStore = new VsCodeTextGenerationSettings();
  const prompts = new FilePromptTemplates(vscode.Uri.joinPath(context.extensionUri, 'resources', 'prompts').fsPath);

  // 应用服务。
  const projectService = new ProjectService(new SqliteProjectRepository(database));
  const workService = new WorkService(new SqliteWorkRepository(database), runs);
  const stageChanges = new ChangeNotifier<StageChange>();
  const runner = new StageRunner({
    runs,
    text: new CopilotTextGeneration(settingsStore),
    workflows: [
      new CreativeWorkflow({
        chapters,
        sources: new SqliteWorkSourceReader(database),
        prompts,
        getSplitSettings: () => settingsStore.getSplitSettings()
      }),
      new ScreenplayWorkflow({ chapters, screenplays, prompts })
    ],
    notify: (run) => stageChanges.notify({ workId: run.workId, runId: run.id, stage: run.stage })
  });
  // 上次退出时还在生成的记录已经无法继续，置为失败，用户可以在产出页点“重试”。
  runner.recoverInterrupted();
  const stageService = new StageService({ works: workService, runs, chapters, screenplays, runner, changes: stageChanges });
  const screenplayService = new ScreenplayService({ works: workService, runs, screenplays, runner, stages: stageService });
  const textSettingsService = new TextSettingsService(settingsStore, new CopilotModelCatalog());

  // 页面。
  const panels = new PanelManager(context.extensionUri);
  const services = { projects: projectService, works: workService, stages: stageService, screenplays: screenplayService };
  const projectPages = new ProjectPages(projectService, panels);
  const workListPages = new WorkListPages(services, panels);
  const settingsPages = new SettingsPages(textSettingsService, panels);

  // 侧栏：尚未实现的入口不注册动作，点击时由侧栏提示“该功能尚未开放”。
  const actionRegistry = new SidebarActionRegistry(SIDEBAR_SECTIONS)
    .register('project-list', 'main', () => projectPages.showProjectList())
    .register('project-list', 'action', () => projectPages.showCreateForm())
    .register('model-settings', 'main', () => settingsPages.show());
  for (const [itemId, sourceType] of CREATION_ENTRIES) {
    // 主入口：打开该素材来源的作品列表页；尾部操作：打开列表页并弹出新建作品表单。
    actionRegistry
      .register(itemId, 'main', () => workListPages.show(sourceType))
      .register(itemId, 'action', () => workListPages.show(sourceType, { action: 'create' }));
  }
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
