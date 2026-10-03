// ------------------------------------------------------------------------
// 名称：extension.ts
// 说明：AIGC Video Studio（AIGC 视频工作室）扩展入口，负责激活时装配数据库、服务、页面与侧栏；数据库无法打开时降级为只含数据备份（恢复）入口的侧栏，并在停用时按顺序收尾。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：入口只做装配，业务逻辑位于 app、domain、infra 目录。
// ------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ShutdownSequence } from './app/lifecycle/shutdown-sequence';
import { MessageRouter } from './app/messaging/message-router';
import { AssetListPages } from './app/pages/asset-list-pages';
import { BackupPages } from './app/pages/backup-pages';
import { ProjectPages } from './app/pages/project-pages';
import { SettingsPages } from './app/pages/settings-pages';
import { WorkListPages } from './app/pages/work-list-pages';
import { WorkbenchHost } from './app/pages/workbench-handlers';
import { WorkbenchPages } from './app/pages/workbench-pages';
import { PanelManager } from './app/panels/panel-manager';
import { JobChange, JobQueue } from './app/queue/job-queue';
import { AssetGenerationQueue } from './app/queue/asset-generation-queue';
import { AssetGenerationService } from './app/services/asset-generation-service';
import { AssetPromptService } from './app/services/asset-prompt-service';
import { AssetService } from './app/services/asset-service';
import { AssetCategoryService } from './app/services/asset-category-service';
import { BackupHost, BackupService } from './app/services/backup-service';
import { BindingService } from './app/services/binding-service';
import { ChangeNotifier } from './app/services/change-notifier';
import { GenerationProfileService } from './app/services/generation-profile-service';
import { GenerationService } from './app/services/generation-service';
import { ProjectService } from './app/services/project-service';
import { ProviderService } from './app/services/provider-service';
import { ScreenplayService } from './app/services/screenplay-service';
import { StageChange, StageService } from './app/services/stage-service';
import { StoryboardService } from './app/services/storyboard-service';
import { TextGenerationRouter } from './app/services/text-generation-router';
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
import { DatabaseFilePaths, applyPendingRestore, resolveDatabaseFilePaths } from './infra/database/database-restore';
import { MIGRATIONS } from './infra/database/migrations';
import { SqliteAssetRepository } from './infra/database/sqlite-asset-repository';
import { SqliteAssetCategoryRepository } from './infra/database/sqlite-asset-category-repository';
import { SqliteAssetVersionRepository } from './infra/database/sqlite-asset-version-repository';
import { SqliteBackupStorage } from './infra/database/sqlite-backup-storage';
import { SqliteBindingRepository } from './infra/database/sqlite-binding-repository';
import { SqliteGenerationProfileRepository } from './infra/database/sqlite-generation-profile-repository';
import { SqliteGenerationRepository } from './infra/database/sqlite-generation-repository';
import { SqliteProjectRepository } from './infra/database/sqlite-project-repository';
import { SqliteProviderRepository } from './infra/database/sqlite-provider-repository';
import { SqliteScreenplayRepository } from './infra/database/sqlite-screenplay-repository';
import { SqliteChapterRepository, SqliteStageRunRepository } from './infra/database/sqlite-stage-run-repository';
import { SqliteStoryboardRepository } from './infra/database/sqlite-storyboard-repository';
import { SqliteWorkRepository } from './infra/database/sqlite-work-repository';
import { SqliteWorkTextModelRepository } from './infra/database/sqlite-work-text-model-repository';
import { SqliteWorkSourceReader } from './infra/database/sqlite-work-source-reader';
import { FilePromptTemplates } from './infra/prompts/file-prompt-templates';
import { createBuiltinProviderRegistry } from './infra/providers/builtin-providers';
import { VsCodeSecretStore } from './infra/secrets/vscode-secret-store';
import { ASSET_FILE_DIRECTORY_NAME, LocalAssetFileStore } from './infra/storage/local-asset-file-store';
import { LocalResultStore, RESULT_VIDEO_DIRECTORY_NAME } from './infra/storage/local-result-store';
import { HttpMediaDownloader } from './infra/storage/http-media-downloader';
import { SidebarActionRegistry } from './sidebar/sidebar-actions';
import { registerSidebarHandlers } from './sidebar/sidebar-handlers';
import { DATABASE_UNAVAILABLE_NOTICE_PREFIX, DEGRADED_SIDEBAR_SECTIONS, SIDEBAR_SECTIONS } from './sidebar/sidebar-menu-config';
import { SIDEBAR_VIEW_ID, SidebarContent, SidebarViewProvider } from './sidebar/sidebar-view-provider';

/** 数据库文件名，位于扩展的全局存储目录。 */
const DATABASE_FILE_NAME = 'aigc-video-studio.sqlite';

/** 任务完成通知上的按钮文字。 */
const WORKBENCH_ACTION_LABEL = '打开工作台';

/** 生成队列的处理间隔：平台生成通常需要一到几分钟，每几秒查询一次足够及时。 */
const JOB_QUEUE_INTERVAL_MS = 5000;

/** 停用时等待后台阶段生成结束的最长时间（毫秒）：给短任务收尾的机会，又不让长时间的模型调用拖住停用。 */
const STAGE_RUN_SHUTDOWN_WAIT_MS = 3000;

/** 侧栏创作入口与素材来源的对应关系。 */
const CREATION_ENTRIES: ReadonlyArray<readonly [string, WorkSourceType]> = [
  ['text-inspiration', 'text'],
  ['image-inspiration', 'image'],
  ['novel-adaptation', 'novel']
];

/** 激活时建立的停用收尾序列；由 deactivate 执行并等待（VS Code 只等待 deactivate 返回的 Promise）。 */
let shutdownSequence: ShutdownSequence | undefined;

/**
 * 激活扩展：打开数据库并升级结构，装配服务与页面，注册侧栏视图。
 * 数据库无法打开时不装配业务服务，只注册降级的侧栏：显示原因，并保留“数据备份（恢复）”入口，让用户可以从备份文件恢复。
 * @param context 扩展上下文，用于登记需要随扩展释放的资源。
 */
export function activate(context: vscode.ExtensionContext): void {
  const databasePaths = resolveDatabaseFilePaths(context.globalStorageUri.fsPath, DATABASE_FILE_NAME);
  const opened = openDatabaseOrReport(context, databasePaths);
  if (opened.database === undefined) {
    activateWithoutDatabase(context, databasePaths, opened.failure);
    return;
  }
  const database = opened.database;

  // 停用收尾：按登记顺序等阶段生成结束、停止两个队列，最后关闭数据库（殿后步骤，与登记先后无关）。
  const shutdown = new ShutdownSequence();
  shutdownSequence = shutdown;
  shutdown.addFinal(() => {
    if (database.isOpen) {
      database.close();
    }
  });
  // 兜底：宿主不经 deactivate 释放订阅时也会执行收尾；序列只执行一次。
  context.subscriptions.push({ dispose: () => void shutdown.run() });

  // 存储与外部服务。
  const runs = new SqliteStageRunRepository(database);
  const chapters = new SqliteChapterRepository(database);
  const screenplays = new SqliteScreenplayRepository(database);
  const storyboards = new SqliteStoryboardRepository(database);
  const settingsStore = new VsCodeTextGenerationSettings();
  const prompts = new FilePromptTemplates(vscode.Uri.joinPath(context.extensionUri, 'resources', 'prompts').fsPath);
  // 服务商服务先于文本生成创建：文本生成按作品的选择、全局默认决定使用 Copilot 还是千问文本模型。
  const providerRepository = new SqliteProviderRepository(database);
  const providerService = new ProviderService({
    repository: providerRepository,
    registry: createBuiltinProviderRegistry(),
    secrets: new VsCodeSecretStore(context.secrets)
  });
  const workTextModels = new SqliteWorkTextModelRepository(database);
  const textRouter = new TextGenerationRouter({
    settings: settingsStore,
    createCopilot: (family) => new CopilotTextGeneration(family),
    providers: providerService,
    workModels: workTextModels
  });
  // 不属于任何作品的文本生成（资产提示词）使用全局默认。
  const textGeneration = textRouter.forWork(null);

  // 应用服务。
  const projectService = new ProjectService(new SqliteProjectRepository(database));
  const workService = new WorkService(new SqliteWorkRepository(database), runs);
  const stageChanges = new ChangeNotifier<StageChange>();
  const runner = new StageRunner({
    runs,
    texts: textRouter,
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
  shutdown.add(() => waitForStageRuns(runner));
  const stageService = new StageService({ works: workService, runs, chapters, screenplays, runner, changes: stageChanges });
  const screenplayService = new ScreenplayService({ works: workService, runs, screenplays, runner, stages: stageService });
  // 资产的图片、音频保存在全局存储目录下，数据库只记路径。
  const assetFileStore = new LocalAssetFileStore(path.join(context.globalStorageUri.fsPath, ASSET_FILE_DIRECTORY_NAME));
  const assetRepository = new SqliteAssetRepository(database, assetFileStore);
  const storyboardService = new StoryboardService({
    works: workService,
    projects: projectService,
    runs,
    screenplays,
    storyboards,
    assets: assetRepository,
    runner,
    stages: stageService
  });
  const textSettingsService = new TextSettingsService(settingsStore, new CopilotModelCatalog(), providerService, workTextModels);
  const assetService = new AssetService(assetRepository);
  const assetCategoryService = new AssetCategoryService(new SqliteAssetCategoryRepository(database));
  const bindingService = new BindingService(new SqliteBindingRepository(database), assetRepository);
  // 把适配器声明的服务商和模型同步到数据库，设置页和后续的参数选择都从数据库读取。
  providerService.syncCatalog();

  // 资产生成：提示词由 Copilot 在后台生成，图片、音频经队列交给图像、音频模型生成；状态变化后通过资产变化事件刷新页面。
  const assetVersionRepository = new SqliteAssetVersionRepository(database, assetFileStore);
  const notifyAssetsChanged = (): void => assetService.notifyChanged();
  const assetPromptService = new AssetPromptService({
    text: textGeneration,
    prompts,
    assets: assetRepository,
    notify: notifyAssetsChanged
  });
  // 上次退出时还在生成的提示词无法继续，置为失败，用户可以在列表里重试。
  assetPromptService.recoverInterrupted();
  const assetQueue = new AssetGenerationQueue({
    versions: assetVersionRepository,
    assets: assetRepository,
    calls: providerService,
    downloader: new HttpMediaDownloader(),
    notify: notifyAssetsChanged
  });
  assetQueue.recover();
  shutdown.add(assetQueue.start(JOB_QUEUE_INTERVAL_MS));
  const assetGenerationService = new AssetGenerationService({
    assets: assetRepository,
    versions: assetVersionRepository,
    providers: providerService,
    scheduler: assetQueue,
    notify: notifyAssetsChanged
  });

  // 视频生成：结果视频保存在全局存储目录；队列启动时先处理上次退出时遗留的任务。
  const generationRepository = new SqliteGenerationRepository(database, assetFileStore);
  const resultStore = new LocalResultStore(context.globalStorageUri.fsPath);
  const jobChanges = new ChangeNotifier<JobChange>();
  const generationProfileRepository = new SqliteGenerationProfileRepository(database);
  const jobQueue = new JobQueue({
    jobs: generationRepository,
    media: generationRepository,
    calls: providerService,
    results: resultStore,
    notify: (change) => jobChanges.notify(change)
  });
  jobQueue.recover();
  shutdown.add(jobQueue.start(JOB_QUEUE_INTERVAL_MS));
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
    profiles: generationProfileRepository,
    scheduler: jobQueue,
    changes: jobChanges
  });
  const profileService = new GenerationProfileService({
    profiles: generationProfileRepository,
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
  const workListPages = new WorkListPages({ ...services, profiles: profileService, providers: providerService, textModels: textSettingsService }, panels);
  const assetListPages = new AssetListPages(
    { projects: projectService, assets: assetService, categories: assetCategoryService, prompts: assetPromptService, generation: assetGenerationService },
    panels
  );
  const settingsPages = new SettingsPages({ text: textSettingsService, providers: providerService }, panels);
  // 数据备份：备份只含数据库，结果视频与资产的图片、音频文件在存储目录的 videos、asset-files 子目录，不在备份内；恢复在重新加载窗口时生效。
  const backupService = new BackupService({
    storage: new SqliteBackupStorage(
      database,
      databasePaths,
      path.join(context.globalStorageUri.fsPath, RESULT_VIDEO_DIRECTORY_NAME),
      path.join(context.globalStorageUri.fsPath, ASSET_FILE_DIRECTORY_NAME)
    ),
    host: createBackupHost(),
    latestSchemaVersion: MIGRATIONS.length
  });
  const backupPages = new BackupPages(backupService, panels);
  const workbenchPages = new WorkbenchPages(
    { generation: generationService, profiles: profileService, bindings: bindingService, assets: assetService, categories: assetCategoryService, prompts: assetPromptService, providers: providerService, ...services },
    // 结果视频用系统默认的视频播放器打开，也可导出到用户选择的位置或在文件夹中显示。
    createWorkbenchHost(),
    panels
  );
  notifyFinishedJobs(context, generationService, () => workbenchPages.show());

  // 侧栏：尚未实现的入口不注册动作，点击时由侧栏提示“该功能尚未开放”。
  const actionRegistry = new SidebarActionRegistry(SIDEBAR_SECTIONS)
    .register('project-list', 'main', () => projectPages.showProjectList())
    .register('project-list', 'action', () => projectPages.showCreateForm())
    .register('model-settings', 'main', () => settingsPages.show())
    .register('data-backup', 'main', () => backupPages.show())
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
  registerSidebar(context, actionRegistry, { sections: SIDEBAR_SECTIONS });
}

/**
 * 数据库无法打开时的降级激活：不装配任何依赖数据库的服务，只注册降级侧栏。
 * 侧栏显示“数据库无法打开：原因”和“数据备份（恢复）”入口；备份页复用同一套备份服务与待恢复机制，
 * 备份服务不带数据库连接，只能选择备份文件、校验、确认并准备恢复，重新加载窗口后由启动流程应用恢复。
 * @param context 扩展上下文。
 * @param paths 数据库相关文件的路径。
 * @param failure 数据库无法打开的原因。
 */
function activateWithoutDatabase(context: vscode.ExtensionContext, paths: DatabaseFilePaths, failure: string): void {
  const backupService = new BackupService({
    storage: new SqliteBackupStorage(
      undefined,
      paths,
      path.join(context.globalStorageUri.fsPath, RESULT_VIDEO_DIRECTORY_NAME),
      path.join(context.globalStorageUri.fsPath, ASSET_FILE_DIRECTORY_NAME)
    ),
    host: createBackupHost(),
    latestSchemaVersion: MIGRATIONS.length,
    databaseUnavailableReason: failure
  });
  const backupPages = new BackupPages(backupService, new PanelManager(context.extensionUri));
  const actionRegistry = new SidebarActionRegistry(DEGRADED_SIDEBAR_SECTIONS).register('data-backup', 'main', () => backupPages.show());
  registerSidebar(context, actionRegistry, { sections: DEGRADED_SIDEBAR_SECTIONS, notice: `${DATABASE_UNAVAILABLE_NOTICE_PREFIX}${failure}` });
}

/** 注册侧栏视图：点击经路由器交给动作注册表。 */
function registerSidebar(context: vscode.ExtensionContext, actionRegistry: SidebarActionRegistry, content: SidebarContent): void {
  const sidebarRouter = new MessageRouter();
  registerSidebarHandlers(sidebarRouter, actionRegistry);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_ID, new SidebarViewProvider(context.extensionUri, sidebarRouter, content))
  );
}

/**
 * 停用扩展：等待收尾序列完成（等待阶段生成、停止队列、关闭数据库），VS Code 会等待返回的 Promise。
 * 降级激活时没有收尾序列，直接结束。
 */
export function deactivate(): Promise<void> {
  return shutdownSequence === undefined ? Promise.resolve() : shutdownSequence.run();
}

/** 等待后台阶段生成结束，最多等 STAGE_RUN_SHUTDOWN_WAIT_MS；超时不再等待（模型调用仍在进行时无法强行结束），也不视为失败。 */
async function waitForStageRuns(runner: StageRunner): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STAGE_RUN_SHUTDOWN_WAIT_MS);
  });
  try {
    // 某次生成的失败已由执行器记录，这里只关心是否结束。
    await Promise.race([runner.whenIdle().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 工作台使用的宿主能力：用系统程序打开、导出到用户选择的位置、在文件夹中显示、读取结果视频（供页面截取尾帧）、右下角通知。 */
function createWorkbenchHost(): WorkbenchHost {
  const revealFile = async (absolutePath: string): Promise<void> => {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(absolutePath));
  };
  return {
    openFile: async (absolutePath) => void (await vscode.env.openExternal(vscode.Uri.file(absolutePath))),
    revealFile,
    readFile: (absolutePath) => readFile(absolutePath),
    exportFile: async (absolutePath, suggestedName) => {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), suggestedName)),
        filters: { 视频: ['mp4'] },
        saveLabel: '导出'
      });
      if (target === undefined) {
        return false;
      }
      await vscode.workspace.fs.copy(vscode.Uri.file(absolutePath), target, { overwrite: true });
      void vscode.window.showInformationMessage(`已导出到 ${target.fsPath}`, '在文件夹中显示').then((choice) => (choice === undefined ? undefined : revealFile(target.fsPath)));
      return true;
    },
    notify: (level, message) => void (level === 'warning' ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message))
  };
}

/** 数据备份使用的宿主能力：选择备份的保存位置、选择要恢复的备份文件、重新加载窗口。 */
function createBackupHost(): BackupHost {
  return {
    pickBackupTarget: async (suggestedName) => {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), suggestedName)),
        filters: { SQLite数据库: ['sqlite'] },
        saveLabel: '备份到此处'
      });
      return target?.fsPath;
    },
    pickRestoreSource: async () => {
      const [source] =
        (await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: true,
          canSelectFolders: false,
          defaultUri: vscode.Uri.file(os.homedir()),
          filters: { SQLite数据库: ['sqlite', 'db'], 所有文件: ['*'] },
          openLabel: '选择备份文件'
        })) ?? [];
      return source?.fsPath;
    },
    reloadWindow: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };
}

/** 视频任务成功或失败时在右下角通知（每个任务每种结果只通知一次），点“打开工作台”进入工作台。 */
function notifyFinishedJobs(context: vscode.ExtensionContext, generation: GenerationService, openWorkbench: () => void): void {
  const notified = new Set<string>();
  const unsubscribe = generation.onDidChangeJobs((change) => {
    if (change.quiet === true) {
      return;
    }
    const outcome = generation.describeFinishedJob(change.jobId);
    if (outcome === undefined) {
      return;
    }
    const key = `${change.jobId}:${outcome.status}`;
    if (notified.has(key)) {
      return;
    }
    notified.add(key);
    const show = outcome.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(outcome.message, WORKBENCH_ACTION_LABEL).then((choice) => (choice === undefined ? undefined : openWorkbench()));
  });
  context.subscriptions.push({ dispose: unsubscribe });
}

/** 打开数据库的结果：成功时有 database；失败时 database 为 undefined，failure 说明原因。 */
type OpenDatabaseResult = { readonly database: ReturnType<typeof openDatabase>; readonly failure?: undefined } | { readonly database?: undefined; readonly failure: string };

/**
 * 在全局存储目录中打开数据库；失败时提示用户并返回原因（调用方据此降级激活）。打开前先应用数据备份页准备好的恢复。
 * @param context 扩展上下文。
 * @param paths 数据库相关文件的路径。
 */
function openDatabaseOrReport(context: vscode.ExtensionContext, paths: DatabaseFilePaths): OpenDatabaseResult {
  try {
    mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
    applyPendingRestoreAndReport(paths);
    return { database: openDatabase(paths.databasePath) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AIGC Video Studio 无法打开数据库：${detail}。可以在侧栏“数据备份（恢复）”中从备份文件恢复。`);
    return { failure: detail };
  }
}

/**
 * 应用数据备份页准备好的恢复，并提示结果；恢复失败时当前数据库保持不变，扩展继续使用它。
 * @param paths 数据库相关文件的路径。
 */
function applyPendingRestoreAndReport(paths: DatabaseFilePaths): void {
  try {
    const autoBackupPath = applyPendingRestore(paths, new Date());
    if (autoBackupPath !== undefined) {
      void vscode.window.showInformationMessage(`AIGC Video Studio 已从备份恢复数据，恢复前的数据库已自动备份到 ${autoBackupPath}。`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`AIGC Video Studio 从备份恢复失败，已继续使用当前数据：${detail}`);
  }
}