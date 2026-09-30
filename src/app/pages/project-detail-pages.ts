// ------------------------------------------------------------------------
// 名称：project-detail-pages.ts
// 说明：项目详情页（P3）的入口：每个项目一个面板，打开时记录为最近使用的项目，并把数据变化推送给页面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求处理在 project-detail-handlers.ts；页面内弹出编辑项目、新建作品表单，因此同时注册项目与创意两组表单。
// ------------------------------------------------------------------------

import { FormCatalog } from '../forms/form-definition';
import { registerFormHandlers } from '../forms/form-handlers';
import { createProjectFormCatalog } from '../forms/project-form';
import { createWorkFormCatalog } from '../forms/work-form';
import { MessageRouter } from '../messaging/message-router';
import { PROJECT_DETAIL_PAGE_RESOURCES } from '../panels/page-resources';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { ProjectService } from '../services/project-service';
import { RecentProjectStore } from '../services/recent-project-store';
import { StageService } from '../services/stage-service';
import { WorkService } from '../services/work-service';
import {
  PROJECT_DETAIL_EVENTS,
  ProjectDetailRequest,
  registerProjectDetailHandlers
} from './project-detail-handlers';

const PROJECT_DETAIL_VIEW_TYPE = 'aiVideoStudio.projectDetail';

/** 已打开的项目详情页。 */
interface OpenedDetail {
  /** 面板句柄；面板创建完成前为 undefined。 */
  panel: OpenedPanel | undefined;
  /** 页面尚未加载完成时登记的请求，页面加载后主动取走。 */
  pending: ProjectDetailRequest | undefined;
}

/** 项目详情页的入口集合。 */
export class ProjectDetailPages {
  private readonly opened = new Map<number, OpenedDetail>();

  /**
   * @param services 项目、作品与阶段服务。
   * @param panels 面板管理器。
   * @param recent 最近使用的项目。
   * @param openStage 打开作品的创意阶段产出页。
   */
  constructor(
    private readonly services: { readonly projects: ProjectService; readonly works: WorkService; readonly stages: StageService },
    private readonly panels: PanelManager,
    private readonly recent: RecentProjectStore,
    private readonly openStage: (workId: number) => void
  ) {}

  /**
   * 打开或聚焦项目详情页，并记录为最近使用的项目。
   * @param projectId 项目标识。
   * @param request 需要页面处理的请求：按素材来源筛选，或弹出新建作品表单。
   */
  show(projectId: number, request?: ProjectDetailRequest): void {
    this.recent.set(projectId);
    const key = panelKey(projectId);
    const existing = this.opened.get(projectId);
    if (existing !== undefined && this.panels.reveal(key)) {
      if (request !== undefined) {
        existing.panel?.postEvent(PROJECT_DETAIL_EVENTS.request, request);
      }
      return;
    }

    const project = this.services.projects.getProject(projectId);
    const entry: OpenedDetail = { panel: undefined, pending: request };
    const router = new MessageRouter();
    registerProjectDetailHandlers(router, projectId, this.services, {
      takePending: () => {
        const taken = entry.pending;
        entry.pending = undefined;
        return taken;
      },
      openStage: this.openStage
    });
    registerFormHandlers(router, this.createFormCatalog());

    const panel = this.panels.open({
      key,
      viewType: PROJECT_DETAIL_VIEW_TYPE,
      title: project.name,
      styles: PROJECT_DETAIL_PAGE_RESOURCES.styles,
      scripts: PROJECT_DETAIL_PAGE_RESOURCES.scripts,
      router
    });
    entry.panel = panel;
    this.opened.set(projectId, entry);

    const notifyChanged = () => panel.postEvent(PROJECT_DETAIL_EVENTS.changed);
    const unsubscribes = [
      // 项目被删除后，详情页已经没有意义，自动关闭；否则刷新页面（项目信息可能被修改）。
      this.services.projects.onDidChangeProjects(() => {
        if (this.services.projects.findProject(projectId) === undefined) {
          panel.close();
        } else {
          notifyChanged();
        }
      }),
      this.services.works.onDidChangeWorks((changedProjectId) => changedProjectId === projectId && notifyChanged()),
      this.services.stages.onDidChange(notifyChanged)
    ];
    panel.onDidClose(() => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      this.opened.delete(projectId);
    });
  }

  /** 页面内可弹出的表单：编辑项目、新建作品与重新生成。 */
  private createFormCatalog(): FormCatalog {
    const { projects, works, stages } = this.services;
    return new Map([
      ...createProjectFormCatalog(projects),
      ...createWorkFormCatalog({ projects, works, stages, onStarted: this.openStage })
    ]);
  }
}

/** 项目详情页的面板键。 */
function panelKey(projectId: number): string {
  return `project-detail:${projectId}`;
}
