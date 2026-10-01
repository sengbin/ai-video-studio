// ------------------------------------------------------------------------
// 名称：project-pages.ts
// 说明：项目相关页面的入口：打开项目列表页；新建、编辑表单和项目详情层都在列表页内以弹出层完成。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求处理的业务逻辑在 project-list-handlers.ts、project-detail-handlers.ts 与 form-handlers.ts；列表页同时注册项目与作品两组表单，并把作品、阶段的变化推送给页面；删除确认在页面内对话框完成，不使用 VS Code 的弹窗。
// ------------------------------------------------------------------------

import { createProjectFormCatalog } from '../forms/project-form';
import { FormCatalog } from '../forms/form-definition';
import { registerFormHandlers } from '../forms/form-handlers';
import { createWorkFormCatalog } from '../forms/work-form';
import { MessageRouter } from '../messaging/message-router';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { PROJECT_LIST_PAGE_RESOURCES } from '../panels/page-resources';
import { ProjectService } from '../services/project-service';
import { RecentProjectStore } from '../services/recent-project-store';
import { StageService } from '../services/stage-service';
import { WorkService } from '../services/work-service';
import { PROJECT_DETAIL_EVENTS, ProjectDetailOptions, registerProjectDetailHandlers } from './project-detail-handlers';
import { PROJECT_LIST_EVENTS, ProjectListRequest, registerProjectListHandlers } from './project-list-handlers';
import { STAGE_EVENTS } from './stage-handlers';

const PROJECT_LIST_PANEL_KEY = 'project-list';
const PROJECT_LIST_VIEW_TYPE = 'aiVideoStudio.projectList';
const PROJECT_LIST_TITLE = '全部项目';

/** 项目相关页面的入口集合。 */
export class ProjectPages {
  private openedList: OpenedPanel | undefined;
  /** 页面尚未加载完成时登记的请求，页面加载后主动取走。 */
  private pendingRequest: ProjectListRequest | undefined;

  /**
   * @param services 项目、作品与阶段服务。
   * @param panels 面板管理器。
   * @param recent 最近使用的项目。
   */
  constructor(
    private readonly services: { readonly projects: ProjectService; readonly works: WorkService; readonly stages: StageService },
    private readonly panels: PanelManager,
    private readonly recent: RecentProjectStore
  ) {}

  /**
   * 打开项目列表页；已打开时聚焦。
   * @param notice 页面顶部显示的提示文字，如“请先选择或创建项目”。
   */
  showProjectList(notice?: string): void {
    this.openList(notice === undefined ? undefined : { notice });
  }

  /** 打开项目列表页并在其中弹出“新建项目”表单；页面已打开时聚焦并直接弹出。 */
  showCreateForm(): void {
    this.openList({ action: 'create' });
  }

  /**
   * 打开项目列表页并在其中弹出项目详情层，同时记为最近使用的项目。
   * @param projectId 项目标识。
   * @param options 详情层需要处理的附加要求：按素材来源筛选，或弹出新建作品表单。
   */
  showProjectDetail(projectId: number, options?: ProjectDetailOptions): void {
    this.recent.set(projectId);
    this.openList({ detail: { projectId, ...options } });
  }

  /**
   * 打开或聚焦列表页，并让它处理请求。
   * @param request 需要页面处理的请求；不需要时为 undefined。
   */
  private openList(request: ProjectListRequest | undefined): void {
    if (this.panels.reveal(PROJECT_LIST_PANEL_KEY)) {
      if (request !== undefined) {
        this.openedList?.postEvent(PROJECT_LIST_EVENTS.action, request);
      }
      return;
    }

    this.pendingRequest = request;
    const { projects, works, stages } = this.services;
    const router = new MessageRouter();
    registerProjectListHandlers(router, projects, {
      takePendingAction: () => {
        const taken = this.pendingRequest;
        this.pendingRequest = undefined;
        return taken;
      },
      markOpened: (projectId) => this.recent.set(projectId)
    });
    registerProjectDetailHandlers(router, this.services);
    registerFormHandlers(router, this.createFormCatalog());

    const opened = this.panels.open({
      key: PROJECT_LIST_PANEL_KEY,
      viewType: PROJECT_LIST_VIEW_TYPE,
      title: PROJECT_LIST_TITLE,
      styles: PROJECT_LIST_PAGE_RESOURCES.styles,
      scripts: PROJECT_LIST_PAGE_RESOURCES.scripts,
      router
    });
    this.openedList = opened;

    const notifyDetailChanged = () => opened.postEvent(PROJECT_DETAIL_EVENTS.changed);
    const unsubscribes = [
      projects.onDidChangeProjects(() => opened.postEvent(PROJECT_LIST_EVENTS.changed)),
      works.onDidChangeWorks(notifyDetailChanged),
      stages.onDidChange((change) => {
        notifyDetailChanged();
        opened.postEvent(STAGE_EVENTS.changed, { workId: change.workId, runId: change.runId });
      })
    ];
    opened.onDidClose(() => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      this.openedList = undefined;
      this.pendingRequest = undefined;
    });
  }

  /** 页面内可弹出的表单：新建、编辑项目，新建作品与重新生成；生成开始后通知页面弹出该作品的创意产出层。 */
  private createFormCatalog(): FormCatalog {
    const { projects, works, stages } = this.services;
    const onStarted = (workId: number): void =>
      this.openedList?.postEvent(PROJECT_DETAIL_EVENTS.openStage, { workId });
    return new Map([...createProjectFormCatalog(projects), ...createWorkFormCatalog({ projects, works, stages, onStarted })]);
  }
}
