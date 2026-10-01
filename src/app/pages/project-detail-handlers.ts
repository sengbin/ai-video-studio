// ------------------------------------------------------------------------
// 名称：project-detail-handlers.ts
// 说明：项目详情层（P3）的请求处理：读取项目与作品列表、创意产出（层内弹出）的请求、带名称确认的作品删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；详情层在项目列表页内弹出，请求载荷带 projectId，作品删除在这里校验它属于该项目；新建作品表单由页面用表单请求完成；作品的创意产出请求带 workId，只校验作品存在。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { WorkSourceType } from '../../domain/models/work';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { ProjectService } from '../services/project-service';
import { StageService } from '../services/stage-service';
import { WorkService } from '../services/work-service';
import { registerStageHandlers } from './stage-handlers';

/** 项目详情层使用的请求名称，需与 resources/project-detail/project-detail.js 一致；载荷都带 projectId。 */
export const PROJECT_DETAIL_REQUESTS = {
  load: 'detail.load',
  prepareDeleteWork: 'detail.prepareDeleteWork',
  deleteWork: 'detail.deleteWork'
} as const;

/** 宿主推送给项目详情层的事件名称：changed 要求刷新数据，openStage 的载荷为 { workId }。 */
export const PROJECT_DETAIL_EVENTS = {
  changed: 'detail.changed',
  openStage: 'detail.openStage'
} as const;

/** 打开详情层时可带的附加要求：按素材来源筛选作品，或直接弹出该来源的新建作品表单。 */
export interface ProjectDetailOptions {
  readonly filterSource?: WorkSourceType;
  readonly createSource?: WorkSourceType;
}

/** 要求项目列表页打开（或已打开时处理）的项目详情层。 */
export interface ProjectDetailRequest extends ProjectDetailOptions {
  readonly projectId: number;
}

/** 删除确认名称不一致时的提示。 */
const CONFIRM_NAME_MISMATCH_MESSAGE = '输入的名称与作品名称不一致。';

/**
 * 在路由器上注册项目详情层的请求处理函数。
 * @param router 面板的请求路由器。
 * @param services 项目、作品与阶段服务。
 */
export function registerProjectDetailHandlers(
  router: MessageRouter,
  services: { readonly projects: ProjectService; readonly works: WorkService; readonly stages: StageService }
): void {
  const { projects, works, stages } = services;

  const readProjectId = (payload: unknown): number => readEntityId({ id: readRecord(payload).projectId }, '项目');
  const readWorkId = (payload: unknown): number => readEntityId({ id: readRecord(payload).workId }, '作品');

  /** 读取属于请求指定项目的作品；其他项目的作品视为不属于它，避免详情层越权删除。 */
  const requireOwnWork = (payload: unknown) => {
    const projectId = readProjectId(payload);
    const work = works.getWork(readEntityId(payload, '作品'));
    if (work.projectId !== projectId) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '作品不属于该项目。' });
    }
    return work;
  };

  router.register(PROJECT_DETAIL_REQUESTS.load, (payload) => {
    const projectId = readProjectId(payload);
    return { project: projects.getProject(projectId), works: works.listWorks(projectId) };
  });

  registerStageHandlers(router, stages, (payload) => works.getWork(readWorkId(payload)).id);

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
