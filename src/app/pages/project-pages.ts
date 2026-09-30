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
import { PROJECT_LIST_EVENTS, ProjectListAction, registerProjectListHandlers } from './project-list-handlers';

const PROJECT_LIST_PANEL_KEY = 'project-list';
const PROJECT_LIST_VIEW_TYPE = 'aiVideoStudio.projectList';
const PROJECT_LIST_TITLE = '全部项目';

/** 项目相关页面的入口集合。 */
export class ProjectPages {
  private openedList: OpenedPanel | undefined;
  /** 页面尚未加载完成时登记的动作，页面加载后主动取走。 */
  private pendingAction: ProjectListAction | undefined;

  constructor(
    private readonly service: ProjectService,
    private readonly panels: PanelManager
  ) {}

  /** 打开项目列表页；已打开时聚焦。 */
  showProjectList(): void {
    this.openList(undefined);
  }

  /** 打开项目列表页并在其中弹出“新建项目”表单；页面已打开时聚焦并直接弹出。 */
  showCreateForm(): void {
    this.openList('create');
  }

  /**
   * 打开或聚焦列表页，并让它执行动作。
   * @param action 需要页面执行的动作；不需要时为 undefined。
   */
  private openList(action: ProjectListAction | undefined): void {
    if (this.panels.reveal(PROJECT_LIST_PANEL_KEY)) {
      if (action !== undefined) {
        this.openedList?.postEvent(PROJECT_LIST_EVENTS.action, { action });
      }
      return;
    }

    this.pendingAction = action;
    const router = new MessageRouter();
    registerProjectListHandlers(router, this.service, {
      takePendingAction: () => {
        const taken = this.pendingAction;
        this.pendingAction = undefined;
        return taken;
      }
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
      this.pendingAction = undefined;
    });
  }
}
