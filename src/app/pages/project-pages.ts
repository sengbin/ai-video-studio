// ------------------------------------------------------------------------
// 名称：project-pages.ts
// 说明：项目相关页面的入口：打开项目列表页、新建与编辑表单。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求处理的业务逻辑在 project-list-handlers.ts；删除确认在页面内对话框完成，不使用 VS Code 的弹窗。
// ------------------------------------------------------------------------

import { Project } from '../../domain/models/project';
import { createEditProjectForm, createNewProjectForm } from '../forms/project-form';
import { FormPanelOpener } from '../forms/form-panel';
import { MessageRouter } from '../messaging/message-router';
import { PROJECT_LIST_PAGE_RESOURCES } from '../panels/page-resources';
import { PanelManager } from '../panels/panel-manager';
import { ProjectService } from '../services/project-service';
import { PROJECT_LIST_EVENTS, registerProjectListHandlers } from './project-list-handlers';

const PROJECT_LIST_PANEL_KEY = 'project-list';
const PROJECT_LIST_VIEW_TYPE = 'aiVideoStudio.projectList';
const PROJECT_LIST_TITLE = '全部项目';

/** 项目相关页面的入口集合。 */
export class ProjectPages {
  private newFormCounter = 0;

  constructor(
    private readonly service: ProjectService,
    private readonly panels: PanelManager,
    private readonly forms: FormPanelOpener
  ) {}

  /** 打开项目列表页；已打开时聚焦。 */
  showProjectList(): void {
    if (this.panels.reveal(PROJECT_LIST_PANEL_KEY)) {
      return;
    }

    const router = new MessageRouter();
    registerProjectListHandlers(router, this.service, {
      openCreateForm: () => this.showCreateForm(),
      openEditForm: (project) => this.showEditForm(project)
    });

    const opened = this.panels.open({
      key: PROJECT_LIST_PANEL_KEY,
      viewType: PROJECT_LIST_VIEW_TYPE,
      title: PROJECT_LIST_TITLE,
      styles: PROJECT_LIST_PAGE_RESOURCES.styles,
      scripts: PROJECT_LIST_PAGE_RESOURCES.scripts,
      router
    });
    const unsubscribe = this.service.onDidChangeProjects(() => opened.postEvent(PROJECT_LIST_EVENTS.changed));
    opened.onDidClose(unsubscribe);
  }

  /** 打开“新建项目”表单；允许同时打开多个。 */
  showCreateForm(): void {
    this.newFormCounter += 1;
    this.forms.open(`project-form:new:${this.newFormCounter}`, createNewProjectForm(this.service));
  }

  /** 打开“编辑项目”表单；同一项目已打开时聚焦。 */
  showEditForm(project: Project): void {
    this.forms.open(`project-form:edit:${project.id}`, createEditProjectForm(this.service, project));
  }
}
