// ------------------------------------------------------------------------
// 名称：project-pages.ts
// 说明：项目相关页面的入口：打开项目列表页；新建、编辑表单都在列表页内以弹出页面完成。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求处理的业务逻辑在 project-list-handlers.ts 与 form-handlers.ts；删除确认在页面内对话框完成，不使用 VS Code 的弹窗。
// ------------------------------------------------------------------------

import { createProjectFormCatalog } from '../forms/project-form';
import { registerFormHandlers } from '../forms/form-handlers';
import { MessageRouter } from '../messaging/message-router';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { PROJECT_LIST_PAGE_RESOURCES } from '../panels/page-resources';
import { ProjectService } from '../services/project-service';
import { PROJECT_LIST_EVENTS, ProjectListRequest, registerProjectListHandlers } from './project-list-handlers';

const PROJECT_LIST_PANEL_KEY = 'project-list';
const PROJECT_LIST_VIEW_TYPE = 'aiVideoStudio.projectList';
const PROJECT_LIST_TITLE = '全部项目';

/** 项目相关页面的入口集合。 */
export class ProjectPages {
  private openedList: OpenedPanel | undefined;
  /** 页面尚未加载完成时登记的请求，页面加载后主动取走。 */
  private pendingRequest: ProjectListRequest | undefined;

  /**
   * @param service 项目服务。
   * @param panels 面板管理器。
   * @param openProject 打开项目详情页。
   */
  constructor(
    private readonly service: ProjectService,
    private readonly panels: PanelManager,
    private readonly openProject: (projectId: number) => void
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
    const router = new MessageRouter();
    registerProjectListHandlers(router, this.service, {
      takePendingAction: () => {
        const taken = this.pendingRequest;
        this.pendingRequest = undefined;
        return taken;
      },
      openProject: this.openProject
    });
    registerFormHandlers(router, createProjectFormCatalog(this.service));

    const opened = this.panels.open({
      key: PROJECT_LIST_PANEL_KEY,
      viewType: PROJECT_LIST_VIEW_TYPE,
      title: PROJECT_LIST_TITLE,
      styles: PROJECT_LIST_PAGE_RESOURCES.styles,
      scripts: PROJECT_LIST_PAGE_RESOURCES.scripts,
      router
    });
    this.openedList = opened;
    const unsubscribe = this.service.onDidChangeProjects(() => opened.postEvent(PROJECT_LIST_EVENTS.changed));
    opened.onDidClose(() => {
      unsubscribe();
      this.openedList = undefined;
      this.pendingRequest = undefined;
    });
  }
}
