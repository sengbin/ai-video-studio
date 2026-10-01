// ------------------------------------------------------------------------
// 名称：project-list-handlers.ts
// 说明：项目列表页的请求处理：读取列表、取走待执行动作、登记最近打开的项目、删除（先取影响范围，再校验确认名称后删除）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；新建、编辑表单由页面用表单请求在弹出页面中完成，删除确认在页面内对话框完成，宿主仅校验确认名称。
// ------------------------------------------------------------------------

import { ValidationError } from '../../domain/errors';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { ProjectService } from '../services/project-service';
import { ProjectDetailRequest } from './project-detail-handlers';

/** 项目列表页使用的请求名称，需与 resources/project-list/project-list.js 一致。 */
export const PROJECT_LIST_REQUESTS = {
  list: 'projects.list',
  takePendingAction: 'projects.takePendingAction',
  open: 'projects.open',
  prepareDelete: 'projects.prepareDelete',
  delete: 'projects.delete'
} as const;

/** 宿主推送给项目列表页的事件名称。 */
export const PROJECT_LIST_EVENTS = {
  changed: 'projects.changed',
  action: 'projects.action'
} as const;

/** 页面打开或已打开时需要它立即执行的动作：目前只有弹出“新建项目”表单。 */
export type ProjectListAction = 'create';

/** 页面打开或已打开时需要它处理的请求：可带一个动作、一句提示文字（如“请先选择或创建项目”），或要求弹出某个项目的详情层。 */
export interface ProjectListRequest {
  readonly action?: ProjectListAction;
  readonly notice?: string;
  readonly detail?: ProjectDetailRequest;
}

/** 删除确认名称不一致时的提示。 */
const CONFIRM_NAME_MISMATCH_MESSAGE = '输入的名称与项目名称不一致。';

/** 项目列表页需要外部提供的能力。 */
export interface ProjectListActions {
  /** 取走页面打开前登记的待处理请求（如侧栏点“创建项目”）；没有时返回 undefined，取走后不再返回。 */
  takePendingAction(): ProjectListRequest | undefined;
  /** 登记项目被打开（记为最近使用的项目）；详情层由页面自己弹出。 */
  markOpened(projectId: number): void;
}

/**
 * 在路由器上注册项目列表页的请求处理函数。
 * @param router 面板的请求路由器。
 * @param service 项目服务。
 * @param actions 外部提供的能力。
 */
export function registerProjectListHandlers(
  router: MessageRouter,
  service: ProjectService,
  actions: ProjectListActions
): void {
  router.register(PROJECT_LIST_REQUESTS.list, () => service.listProjects());

  router.register(PROJECT_LIST_REQUESTS.takePendingAction, () => {
    const taken = actions.takePendingAction();
    return { action: taken?.action, notice: taken?.notice, detail: taken?.detail };
  });

  router.register(PROJECT_LIST_REQUESTS.open, (payload) => {
    const project = service.getProject(readEntityId(payload, '项目'));
    actions.markOpened(project.id);
    return { opened: true };
  });

  router.register(PROJECT_LIST_REQUESTS.prepareDelete, (payload) => {
    const project = service.getProject(readEntityId(payload, '项目'));
    return { name: project.name, ...service.getDeletionImpact(project.id) };
  });

  router.register(PROJECT_LIST_REQUESTS.delete, (payload) => {
    const project = service.getProject(readEntityId(payload, '项目'));
    if (readRecord(payload).confirmName !== project.name) {
      throw new ValidationError({ confirmName: CONFIRM_NAME_MISMATCH_MESSAGE });
    }
    service.deleteProject(project.id);
    return { deleted: true, name: project.name };
  });
}
