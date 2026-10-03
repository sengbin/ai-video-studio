// ------------------------------------------------------------------------
// 名称：workbench-pages.ts
// 说明：生成工作台页（P5）的入口：打开或聚焦工作台，把任务与分镜脚本的变化推送给页面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求处理在 workbench-handlers.ts；页内“重新生成分镜脚本”表单复用分镜表单目录，开始后产出层自己刷新，不需要额外跳转。
// ------------------------------------------------------------------------

import { createAssetFormCatalog } from '../forms/asset-form';
import { FormCatalog } from '../forms/form-definition';
import { registerFormHandlers } from '../forms/form-handlers';
import { createStoryboardFormCatalog } from '../forms/storyboard-form';
import { MessageRouter } from '../messaging/message-router';
import { WORKBENCH_PAGE_RESOURCES } from '../panels/page-resources';
import { PanelManager } from '../panels/panel-manager';
import { AssetCategoryService } from '../services/asset-category-service';
import { AssetPromptService } from '../services/asset-prompt-service';
import { AssetService } from '../services/asset-service';
import { ProjectService } from '../services/project-service';
import { ProviderService } from '../services/provider-service';
import { STAGE_EVENTS } from './stage-handlers';
import { WORKBENCH_EVENTS, WorkbenchHost, WorkbenchServices, registerWorkbenchHandlers } from './workbench-handlers';

const WORKBENCH_PANEL_KEY = 'workbench';
const WORKBENCH_VIEW_TYPE = 'aigcVideoStudio.workbench';
const WORKBENCH_TITLE = '生成工作台';
const WORKBENCH_DESCRIPTION = '按镜头组为已确认的分镜脚本生成视频，一组一次生成一个多镜头视频；生成失败时显示平台返回的具体原因，修改后可再次生成。';

/** 工作台页依赖的服务。 */
export interface WorkbenchPageServices extends WorkbenchServices {
  readonly projects: ProjectService;
  readonly assets: AssetService;
  readonly categories: AssetCategoryService;
  readonly prompts: AssetPromptService;
  readonly providers: ProviderService;
}

/** 工作台页的入口。 */
export class WorkbenchPages {
  constructor(
    private readonly services: WorkbenchPageServices,
    private readonly host: WorkbenchHost,
    private readonly panels: PanelManager
  ) {}

  /** 打开工作台；已打开时聚焦。 */
  show(): void {
    if (this.panels.reveal(WORKBENCH_PANEL_KEY)) {
      return;
    }
    const { generation, profiles, bindings, assets, categories, prompts, works, stages, projects, storyboards, providers } = this.services;
    const router = new MessageRouter();
    registerWorkbenchHandlers(router, this.services, this.host);
    // 产出层里的“重新生成”会弹出分镜表单（作品和集都已确定，开始后产出层随阶段事件自行刷新）；实体绑定页的“新建资产”弹出资产表单。路由器只能注册一次表单请求，因此合并两个目录。
    const catalog: FormCatalog = new Map([
      ...createStoryboardFormCatalog({ projects, works, storyboards, profiles, providers, onStarted: () => undefined, onPicked: () => undefined }),
      ...createAssetFormCatalog({ projects, assets, categories, prompts, entities: bindings })
    ]);
    registerFormHandlers(router, catalog);

    const panel = this.panels.open({
      key: WORKBENCH_PANEL_KEY,
      viewType: WORKBENCH_VIEW_TYPE,
      title: WORKBENCH_TITLE,
      description: WORKBENCH_DESCRIPTION,
      styles: WORKBENCH_PAGE_RESOURCES.styles,
      scripts: WORKBENCH_PAGE_RESOURCES.scripts,
      router
    });

    const unsubscribes = [
      generation.onDidChangeJobs(() => panel.postEvent(WORKBENCH_EVENTS.changed)),
      works.onDidChangeWorks(() => panel.postEvent(WORKBENCH_EVENTS.changed)),
      projects.onDidChangeProjects(() => panel.postEvent(WORKBENCH_EVENTS.changed)),
      bindings.onDidChangeBindings(() => panel.postEvent(WORKBENCH_EVENTS.changed)),
      profiles.onDidChangeProfiles(() => panel.postEvent(WORKBENCH_EVENTS.changed)),
      assets.onDidChangeAssets(() => panel.postEvent(WORKBENCH_EVENTS.changed)),
      stages.onDidChange((change) => {
        panel.postEvent(WORKBENCH_EVENTS.changed);
        panel.postEvent(STAGE_EVENTS.changed, { workId: change.workId, runId: change.runId });
      })
    ];
    panel.onDidClose(() => unsubscribes.forEach((unsubscribe) => unsubscribe()));
  }
}
