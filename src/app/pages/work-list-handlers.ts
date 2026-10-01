// ------------------------------------------------------------------------
// 名称：work-list-handlers.ts
// 说明：作品列表页（P3）的请求处理：读取某个视图下全部项目的作品（按素材来源，或跨来源的剧本视图）、取走待执行动作、阶段产出（页内弹出层）的请求、带名称确认的作品删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-01
// 备注：不依赖 VS Code；一个页面绑定一个视图，请求不需要再带视图；新建、编辑、重新生成、生成剧本表单由页面用表单请求在弹出页面中完成；作品的阶段产出请求带 workId，只校验作品存在。
// ------------------------------------------------------------------------

import { ValidationError } from '../../domain/errors';
import { WorkSourceType } from '../../domain/models/work';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { ProjectService } from '../services/project-service';
import { ScreenplayService } from '../services/screenplay-service';
import { StageService } from '../services/stage-service';
import { WorkListItem, WorkService } from '../services/work-service';
import { registerStageHandlers } from './stage-handlers';

/** 作品列表页使用的请求名称，需与 resources/work-list/work-list.js 一致。 */
export const WORK_LIST_REQUESTS = {
  load: 'works.load',
  takePending: 'works.takePending',
  prepareDelete: 'works.prepareDelete',
  delete: 'works.delete'
} as const;

/** 宿主推送给作品列表页的事件名称：changed 要求刷新数据，action 要求执行动作，openStage 的载荷为 { workId, stage }，startScreenplay 的载荷为 { workId }（已选好作品，要求弹出“生成剧本”表单）。 */
export const WORK_LIST_EVENTS = {
  changed: 'works.changed',
  action: 'works.action',
  openStage: 'works.openStage',
  startScreenplay: 'works.startScreenplay'
} as const;

/** 页面打开或已打开时需要它立即执行的动作：弹出“新建作品”表单（剧本视图中为选择作品并生成剧本）。 */
export type WorkListAction = 'create';

/** 页面打开或已打开时需要它处理的请求。 */
export interface WorkListRequest {
  readonly action?: WorkListAction;
}

/** 作品列表页的视图：某种素材来源的作品，或跨素材来源、以剧本为中心的列表。 */
export type WorkListView = WorkSourceType | typeof SCREENPLAY_VIEW;

/** 剧本视图的标识。 */
export const SCREENPLAY_VIEW = 'screenplay';

/** 删除确认名称不一致时的提示。 */
const CONFIRM_NAME_MISMATCH_MESSAGE = '输入的名称与作品名称不一致。';

/** 列表中的一行：作品、所属项目的名称，剧本视图还带最新剧本的集数与实体数。 */
export interface WorkListRow extends WorkListItem {
  readonly projectName: string;
  readonly contentCounts: { readonly episodes: number; readonly entities: number } | null;
}

/** 作品列表页需要外部提供的能力。 */
export interface WorkListActions {
  /** 取走页面打开前登记的待处理请求；没有时返回 undefined，取走后不再返回。 */
  takePending(): WorkListRequest | undefined;
}

/**
 * 在路由器上注册作品列表页的请求处理函数。
 * @param router 面板的请求路由器。
 * @param view 页面绑定的视图。
 * @param services 项目、作品、阶段与剧本服务。
 * @param actions 外部提供的能力。
 */
export function registerWorkListHandlers(
  router: MessageRouter,
  view: WorkListView,
  services: {
    readonly projects: ProjectService;
    readonly works: WorkService;
    readonly stages: StageService;
    readonly screenplays: ScreenplayService;
  },
  actions: WorkListActions
): void {
  const { projects, works, stages, screenplays } = services;

  router.register(WORK_LIST_REQUESTS.load, () => {
    const summaries = projects.listProjects();
    const names = new Map(summaries.map((project) => [project.id, project.name]));
    // 剧本视图只列创意已确认（可以生成剧本）或已有剧本记录的作品。
    const items =
      view === SCREENPLAY_VIEW
        ? works.listAllWorks().filter((work) => work.canStartScreenplay || work.screenplay.runId !== null)
        : works.listWorksBySource(view);
    const rows: WorkListRow[] = items.map((work) => ({
      ...work,
      projectName: names.get(work.projectId) ?? '',
      contentCounts: view === SCREENPLAY_VIEW ? screenplays.getContentCounts(work.id) : null
    }));
    return { view, projects: summaries.map(({ id, name }) => ({ id, name })), works: rows };
  });

  router.register(WORK_LIST_REQUESTS.takePending, () => ({ request: actions.takePending() }));

  registerStageHandlers(
    router,
    { stages, screenplays },
    (payload) => works.getWork(readEntityId({ id: readRecord(payload).workId }, '作品')).id
  );

  router.register(WORK_LIST_REQUESTS.prepareDelete, (payload) => ({ name: works.getWork(readEntityId(payload, '作品')).name }));

  router.register(WORK_LIST_REQUESTS.delete, (payload) => {
    const work = works.getWork(readEntityId(payload, '作品'));
    if (readRecord(payload).confirmName !== work.name) {
      throw new ValidationError({ confirmName: CONFIRM_NAME_MISMATCH_MESSAGE });
    }
    stages.cancelRunningForWork(work.id);
    works.deleteWork(work.id);
    return { deleted: true, name: work.name };
  });
}
