// ------------------------------------------------------------------------
// 名称：project-list-handlers.ts
// 说明：项目列表页的请求处理：读取列表、创建、编辑、删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；打开表单和删除确认通过 actions 注入。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { Project } from '../../domain/models/project';
import { readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { ProjectService } from '../services/project-service';

/** 项目列表页使用的请求名称，需与 resources/project-list/project-list.js 一致。 */
export const PROJECT_LIST_REQUESTS = {
  list: 'projects.list',
  create: 'projects.create',
  edit: 'projects.edit',
  delete: 'projects.delete'
} as const;

/** 宿主推送给项目列表页的事件名称。 */
export const PROJECT_LIST_EVENTS = {
  changed: 'projects.changed'
} as const;

/** 项目列表页需要外部完成的界面动作。 */
export interface ProjectListActions {
  /** 打开“新建项目”表单。 */
  openCreateForm(): void;
  /** 打开“编辑项目”表单。 */
  openEditForm(project: Project): void;
  /** 确认并删除项目；返回是否已删除。 */
  confirmAndDelete(project: Project): Promise<boolean>;
}

/**
 * 在路由器上注册项目列表页的请求处理函数。
 * @param router 面板的请求路由器。
 * @param service 项目服务。
 * @param actions 界面动作。
 */
export function registerProjectListHandlers(
  router: MessageRouter,
  service: ProjectService,
  actions: ProjectListActions
): void {
  router.register(PROJECT_LIST_REQUESTS.list, () => service.listProjects());

  router.register(PROJECT_LIST_REQUESTS.create, () => {
    actions.openCreateForm();
    return {};
  });

  router.register(PROJECT_LIST_REQUESTS.edit, (payload) => {
    actions.openEditForm(service.getProject(readProjectId(payload)));
    return {};
  });

  router.register(PROJECT_LIST_REQUESTS.delete, async (payload) => {
    const project = service.getProject(readProjectId(payload));
    return { deleted: await actions.confirmAndDelete(project) };
  });
}

/** 读取请求载荷中的项目标识，必须是整数。 */
function readProjectId(payload: unknown): number {
  const id = readRecord(payload).id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '项目标识无效。' });
  }
  return id;
}
