// ------------------------------------------------------------------------
// 名称：project-detail-handlers.ts
// 说明：项目详情页（P3）的请求处理：读取项目与作品列表、取走待处理请求、创意产出（页内弹出层）的请求、带名称确认的作品删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；页面绑定一个项目，请求不需要再带项目标识；新建作品、编辑项目表单由页面用表单请求在弹出页面中完成；作品的创意产出请求带 workId，在这里校验它属于本项目。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { WorkSourceType } from '../../domain/models/work';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { ProjectService } from '../services/project-service';
import { StageService } from '../services/stage-service';
import { WorkService } from '../services/work-service';
import { registerStageHandlers } from './stage-handlers';

/** 项目详情页使用的请求名称，需与 resources/project-detail/project-detail.js 一致。 */
export const PROJECT_DETAIL_REQUESTS = {
  load: 'detail.load',
  takePending: 'detail.takePending',
  prepareDeleteWork: 'detail.prepareDeleteWork',
  deleteWork: 'detail.deleteWork'
} as const;

/** 宿主推送给项目详情页的事件名称。 */
export const PROJECT_DETAIL_EVENTS = {
  changed: 'detail.changed',
  request: 'detail.request'
} as const;

/** 页面打开或已打开时需要它处理的请求：按素材来源筛选作品，直接弹出该来源的新建作品表单，或弹出某个作品的创意产出层。 */
export interface ProjectDetailRequest {
  readonly filterSource?: WorkSourceType;
  readonly createSource?: WorkSourceType;
  /** 要弹出创意产出层的作品标识。 */
  readonly openStage?: number;
}

/** 删除确认名称不一致时的提示。 */
const CONFIRM_NAME_MISMATCH_MESSAGE = '输入的名称与作品名称不一致。';

/** 项目详情页需要外部提供的能力。 */
export interface ProjectDetailActions {
  /** 取走页面打开前登记的待处理请求；没有时返回 undefined，取走后不再返回。 */
  takePending(): ProjectDetailRequest | undefined;
}

/**
 * 在路由器上注册项目详情页的请求处理函数。
 * @param router 面板的请求路由器。
 * @param projectId 页面绑定的项目。
 * @param services 项目、作品与阶段服务。
 * @param actions 外部提供的能力。
 */
export function registerProjectDetailHandlers(
  router: MessageRouter,
  projectId: number,
  services: { readonly projects: ProjectService; readonly works: WorkService; readonly stages: StageService },
  actions: ProjectDetailActions
): void {
  const { projects, works, stages } = services;

  /** 读取属于本项目的作品；其他项目的作品视为不存在，避免页面越权操作。 */
  const requireOwnWorkById = (workId: number) => {
    const work = works.getWork(workId);
    if (work.projectId !== projectId) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '作品不属于当前项目。' });
    }
    return work;
  };
  const requireOwnWork = (payload: unknown) => requireOwnWorkById(readEntityId(payload, '作品'));

  router.register(PROJECT_DETAIL_REQUESTS.load, () => ({
    project: projects.getProject(projectId),
    works: works.listWorks(projectId)
  }));

  router.register(PROJECT_DETAIL_REQUESTS.takePending, () => ({ request: actions.takePending() }));

  registerStageHandlers(router, stages, (payload) => requireOwnWorkById(readEntityId({ id: readRecord(payload).workId }, '作品')).id);

  router.register(PROJECT_DETAIL_REQUESTS.prepareDeleteWork, (payload) => ({ name: requireOwnWork(payload).name }));

  router.register(PROJECT_DETAIL_REQUESTS.deleteWork, (payload) => {
    const work = requireOwnWork(payload);
    if (readRecord(payload).confirmName !== work.name) {
      throw new ValidationError({ confirmName: CONFIRM_NAME_MISMATCH_MESSAGE });
    }
    stages.cancelRunningForWork(work.id);
    works.deleteWork(work.id);
    return { deleted: true, name: work.name };
  });
}
