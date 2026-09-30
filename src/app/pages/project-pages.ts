// ------------------------------------------------------------------------
// 名称：project-pages.ts
// 说明：项目相关页面的入口：打开项目列表页、新建与编辑表单，以及带确认的删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 VS Code 界面接口；请求处理的业务逻辑在 project-list-handlers.ts。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { Project } from '../../domain/models/project';
import { createEditProjectForm, createNewProjectForm } from '../forms/project-form';
import { FormPanelOpener } from '../forms/form-panel';
import { MessageRouter } from '../messaging/message-router';
import { PanelManager } from '../panels/panel-manager';
import { ProjectService } from '../services/project-service';
import { PROJECT_LIST_EVENTS, registerProjectListHandlers } from './project-list-handlers';

const PROJECT_LIST_PANEL_KEY = 'project-list';
const PROJECT_LIST_VIEW_TYPE = 'aiVideoStudio.projectList';
const PROJECT_LIST_TITLE = '全部项目';
const PROJECT_LIST_STYLES = ['shared/theme.css', 'shared/controls.css', 'project-list/project-list.css'] as const;
const PROJECT_LIST_SCRIPTS = ['shared/host-bridge.js', 'project-list/project-list.js'] as const;

const DELETE_SUCCESS_MESSAGE = (name: string): string => `已删除项目“${name}”。`;
const NAME_MISMATCH_MESSAGE = '输入的名称与项目名称不一致。';

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
      openEditForm: (project) => this.showEditForm(project),
      confirmAndDelete: (project) => this.confirmAndDelete(project)
    });

    const opened = this.panels.open({
      key: PROJECT_LIST_PANEL_KEY,
      viewType: PROJECT_LIST_VIEW_TYPE,
      title: PROJECT_LIST_TITLE,
      styles: PROJECT_LIST_STYLES,
      scripts: PROJECT_LIST_SCRIPTS,
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

  /**
   * 展示影响范围并要求输入项目名称确认后删除项目。
   * @returns 是否已删除。
   */
  private async confirmAndDelete(project: Project): Promise<boolean> {
    const impact = this.service.getDeletionImpact(project.id);
    const answer = await vscode.window.showInputBox({
      title: `删除项目“${project.name}”`,
      prompt: `将同时删除 ${impact.workCount} 个作品、${impact.assetCount} 个资产、${impact.videoResultCount} 个视频结果，且无法恢复。请输入项目名称确认删除。`,
      placeHolder: project.name,
      ignoreFocusOut: true,
      validateInput: (value) => (value === project.name ? undefined : NAME_MISMATCH_MESSAGE)
    });
    if (answer !== project.name) {
      return false;
    }

    this.service.deleteProject(project.id);
    void vscode.window.showInformationMessage(DELETE_SUCCESS_MESSAGE(project.name));
    return true;
  }
}
