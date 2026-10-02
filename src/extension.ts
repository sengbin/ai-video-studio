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
import { AssetListPages } from './app/pages/asset-list-pages';
import { ProjectPages } from './app/pages/project-pages';
import { SettingsPages } from './app/pages/settings-pages';
import { WorkListPages } from './app/pages/work-list-pages';
import { WorkbenchPages } from './app/pages/workbench-pages';
import { PanelManager } from './app/panels/panel-manager';
import { JobChange, JobQueue } from './app/queue/job-queue';
import { AssetPromptService } from './app/services/asset-prompt-service';
import { AssetService } from './app/services/asset-service';
import { BindingService } from './app/services/binding-service';
import { ChangeNotifier } from './app/services/change-notifier';
import { GenerationProfileService } from './app/services/generation-profile-service';
import { GenerationService } from './app/services/generation-service';
import { ProjectService } from './app/services/project-service';
import { ProviderService } from './app/services/provider-service';
import { ScreenplayService } from './app/services/screenplay-service';
import { StageChange, StageService } from './app/services/stage-service';
import { StoryboardService } from './app/services/storyboard-service';
import { TextSettingsService } from './app/services/text-settings-service';
import { WorkService } from './app/services/work-service';
import { CreativeWorkflow } from './app/stages/creative-workflow';
import { ScreenplayWorkflow } from './app/stages/screenplay-workflow';
import { StageRunner } from './app/stages/stage-runner';
import { StoryboardWorkflow } from './app/stages/storyboard-workflow';
import { WorkSourceType } from './domain/models/work';
import { ASSET_KINDS } from './domain/models/asset';
import { CopilotModelCatalog } from './infra/copilot/copilot-model-catalog';
import { CopilotTextGeneration } from './infra/copilot/copilot-text-generation';
import { VsCodeTextGenerationSettings } from './infra/copilot/vscode-text-generation-settings';
import { openDatabase } from './infra/database/database-connection';
import { SqliteAssetRepository } from './infra/database/sqlite-asset-repository';
import { SqliteBindingRepository } from './infra/database/sqlite-binding-repository';
import { SqliteGenerationProfileRepository } from './infra/database/sqlite-generation-profile-repository';
import { SqliteGenerationRepository } from './infra/database/sqlite-generation-repository';
import { SqliteProjectRepository } from './infra/database/sqlite-project-repository';
import { SqliteProviderRepository } from './infra/database/sqlite-provider-repository';
import { SqliteScreenplayRepository } from './infra/database/sqlite-screenplay-repository';
import { SqliteChapterRepository, SqliteStageRunRepository } from './infra/database/sqlite-stage-run-repository';
import { SqliteStoryboardRepository } from './infra/database/sqlite-storyboard-repository';
import { SqliteWorkRepository } from './infra/database/sqlite-work-repository';
import { SqliteWorkSourceReader } from './infra/database/sqlite-work-source-reader';
import { FilePromptTemplates } from './infra/prompts/file-prompt-templates';
import { createBuiltinProviderRegistry } from './infra/providers/builtin-providers';
import { VsCodeSecretStore } from './infra/secrets/vscode-secret-store';
import { LocalResultStore } from './infra/storage/local-result-store';
import { SidebarActionRegistry } from './sidebar/sidebar-actions';
import { registerSidebarHandlers } from './sidebar/sidebar-handlers';
import { SIDEBAR_SECTIONS } from './sidebar/sidebar-menu-config';
import { SIDEBAR_VIEW_ID, SidebarViewProvider } from './sidebar/sidebar-view-provider';

/** 数据库文件名，位于扩展的全局存储目录。 */
const DATABASE_FILE_NAME = 'ai-video-studio.sqlite';

/** 生成队列的处理间隔：平台生成通常需要一到几分钟，每几秒查询一次足够及时。 */
const JOB_QUEUE_INTERVAL_MS = 5000;

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
  const storyboards = new SqliteStoryboardRepository(database);
  const settingsStore = new VsCodeTextGenerationSettings();
  const prompts = new FilePromptTemplates(vscode.Uri.joinPath(context.extensionUri, 'resources', 'prompts').fsPath);
  const textGeneration = new CopilotTextGeneration(settingsStore);

  // 应用服务。
  const projectService = new ProjectService(new SqliteProjectRepository(database));
  const workService = new WorkService(new SqliteWorkRepository(database), runs);
  const stageChanges = new ChangeNotifier<StageChange>();
  const runner = new StageRunner({
    runs,
    text: textGeneration,
    workflows: [
      new CreativeWorkflow({
        chapters,
        sources: new SqliteWorkSourceReader(database),
        prompts,
        getSplitSettings: () => settingsStore.getSplitSettings()
      }),
      new ScreenplayWorkflow({ chapters, screenplays, prompts }),
      new StoryboardWorkflow({ screenplays, storyboards, prompts })
    ],
    notify: (run) => stageChanges.notify({ workId: run.workId, runId: run.id, stage: run.stage })
  });
  // 上次退出时还在生成的记录已经无法继续，置为失败，用户可以在产出页点“重试”。
  runner.recoverInterrupted();
  const stageService = new StageService({ works: workService, runs, chapters, screenplays, runner, changes: stageChanges });
  const screenplayService = new ScreenplayService({ works: workService, runs, screenplays, runner, stages: stageService });
  const storyboardService = new StoryboardService({
    works: workService,
    projects: projectService,
    runs,
    screenplays,
    storyboards,
    runner,
    stages: stageService
  });
  const textSettingsService = new TextSettingsService(settingsStore, new CopilotModelCatalog());
  const assetRepository = new SqliteAssetRepository(database);
  const assetService = new AssetService(assetRepository, projectService);
  const assetPromptService = new AssetPromptService({ text: textGeneration, prompts, projects: projectService });
  const bindingService = new BindingService(new SqliteBindingRepository(database), assetRepository);
  const providerRepository = new SqliteProviderRepository(database);
  const providerService = new ProviderService({
    repository: providerRepository,
    registry: createBuiltinProviderRegistry(),
    secrets: new VsCodeSecretStore(context.secrets)
  });
  // 把适配器声明的服务商和模型同步到数据库，设置页和后续的参数选择都从数据库读取。
  providerService.syncCatalog();

  // 视频生成：结果视频保存在全局存储目录；队列启动时先处理上次退出时遗留的任务。
  const generationRepository = new SqliteGenerationRepository(database);
  const resultStore = new LocalResultStore(context.globalStorageUri.fsPath);
  const jobChanges = new ChangeNotifier<JobChange>();
  const jobQueue = new JobQueue({
    jobs: generationRepository,
    media: generationRepository,
    calls: providerService,
    results: resultStore,
    notify: (change) => jobChanges.notify(change)
  });
  jobQueue.recover();
  context.subscriptions.push({ dispose: jobQueue.start(JOB_QUEUE_INTERVAL_MS) });
  const generationService = new GenerationService({
    works: workService,
    projects: projectService,
    storyboardService,
    runs,
    screenplays,
    storyboards,
    bindings: new SqliteBindingRepository(database),
    assets: assetRepository,
    jobs: generationRepository,
    media: generationRepository,
    results: resultStore,
    models: providerRepository,
    providers: providerService,
    scheduler: jobQueue,
    changes: jobChanges
  });
  const profileService = new GenerationProfileService({
    profiles: new SqliteGenerationProfileRepository(database),
    works: workService,
    projects: projectService,
    screenplays,
    models: providerRepository
  });

  // 页面。
  const panels = new PanelManager(context.extensionUri);
  const services = {
    projects: projectService,
    works: workService,
    stages: stageService,
    screenplays: screenplayService,
    storyboards: storyboardService
  };
  const projectPages = new ProjectPages(projectService, panels);
  const workListPages = new WorkListPages(services, panels);
  const assetListPages = new AssetListPages({ projects: projectService, assets: assetService, prompts: assetPromptService }, panels);
  const settingsPages = new SettingsPages({ text: textSettingsService, providers: providerService }, panels);
  const workbenchPages = new WorkbenchPages(
    { generation: generationService, profiles: profileService, bindings: bindingService, assets: assetService, prompts: assetPromptService, ...services },
    // 结果视频用系统默认的视频播放器打开。
    { openFile: async (absolutePath) => void (await vscode.env.openExternal(vscode.Uri.file(absolutePath))) },
    panels
  );

  // 侧栏：尚未实现的入口不注册动作，点击时由侧栏提示“该功能尚未开放”。
  const actionRegistry = new SidebarActionRegistry(SIDEBAR_SECTIONS)
    .register('project-list', 'main', () => projectPages.showProjectList())
    .register('project-list', 'action', () => projectPages.showCreateForm())
    .register('model-settings', 'main', () => settingsPages.show())
    .register('video-workbench', 'main', () => workbenchPages.show());
  for (const [itemId, sourceType] of CREATION_ENTRIES) {
    // 主入口：打开该素材来源的作品列表页；尾部操作：打开列表页并弹出新建作品表单。
    actionRegistry
      .register(itemId, 'main', () => workListPages.show(sourceType))
      .register(itemId, 'action', () => workListPages.show(sourceType, { action: 'create' }));
  }
  // 剧本：主入口打开跨素材来源的剧本列表；添加打开列表并弹出“选择作品”。
  actionRegistry
    .register('screenplay', 'main', () => workListPages.show('screenplay'))
    .register('screenplay', 'action', () => workListPages.show('screenplay', { action: 'create' }));
  // 分镜：主入口打开分镜脚本列表；添加打开列表并弹出“选择作品”。
  actionRegistry
    .register('storyboard-script', 'main', () => workListPages.show('storyboard'))
    .register('storyboard-script', 'action', () => workListPages.show('storyboard', { action: 'create' }));
  // 资产：主入口打开该类型的资产列表；添加打开列表并弹出新建资产表单。侧栏条目标识与资产类型同名。
  for (const kind of ASSET_KINDS) {
    actionRegistry
      .register(kind, 'main', () => assetListPages.show(kind))
      .register(kind, 'action', () => assetListPages.show(kind, { action: 'create' }));
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
