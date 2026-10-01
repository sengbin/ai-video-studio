// ------------------------------------------------------------------------
// 名称：work-list-pages.ts
// 说明：作品列表页（P3）的入口：每种素材来源一个面板，列出所有项目中该来源的作品；另有一个跨来源的“剧本”面板；新建、编辑、重新生成、生成剧本表单和阶段产出层都在页内弹出。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-01
// 备注：请求处理在 work-list-handlers.ts 与 form-handlers.ts；把作品、项目与阶段的变化推送给页面。
// ------------------------------------------------------------------------

import { StageKind } from '../../domain/models/stage-run';
import { registerFormHandlers } from '../forms/form-handlers';
import { createScreenplayFormCatalog } from '../forms/screenplay-form';
import { createWorkFormCatalog } from '../forms/work-form';
import { MessageRouter } from '../messaging/message-router';
import { WORK_LIST_PAGE_RESOURCES } from '../panels/page-resources';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { ProjectService } from '../services/project-service';
import { ScreenplayService } from '../services/screenplay-service';
import { StageService } from '../services/stage-service';
import { WorkService } from '../services/work-service';
import { STAGE_EVENTS } from './stage-handlers';
import { WORK_LIST_EVENTS, WorkListRequest, WorkListView, registerWorkListHandlers } from './work-list-handlers';

const WORK_LIST_VIEW_TYPE = 'aiVideoStudio.workList';

/** 各视图的页面标题，与侧栏“创作”“脚本”分区的条目名称一致。 */
const WORK_LIST_TITLES: Readonly<Record<WorkListView, string>> = {
  text: '文字灵感',
  image: '图片灵感',
  novel: '小说改编',
  screenplay: '剧本'
};

/** 各视图的页面描述，显示在页面顶部标题栏里。 */
const WORK_LIST_DESCRIPTIONS: Readonly<Record<WorkListView, string>> = {
  text: '所有项目中以文字灵感为素材的作品，可新建作品、查看创意、修改和删除。',
  image: '所有项目中以灵感图片为素材的作品，可新建作品、查看创意、修改和删除。',
  novel: '所有项目中以小说原文为素材的作品，可新建作品、查看创意、修改和删除。',
  screenplay: '创意已确认的作品，可生成、查看和编辑剧本，确认采用后合并集和实体。'
};

/** 已打开的作品列表页。 */
interface OpenedWorkList {
  /** 面板句柄；面板创建完成前为 undefined。 */
  panel: OpenedPanel | undefined;
  /** 页面尚未加载完成时登记的请求，页面加载后主动取走。 */
  pending: WorkListRequest | undefined;
}

/** 作品列表页的入口集合。 */
export class WorkListPages {
  private readonly opened = new Map<WorkListView, OpenedWorkList>();

  /**
   * @param services 项目、作品、阶段与剧本服务。
   * @param panels 面板管理器。
   */
  constructor(
    private readonly services: {
      readonly projects: ProjectService;
      readonly works: WorkService;
      readonly stages: StageService;
      readonly screenplays: ScreenplayService;
    },
    private readonly panels: PanelManager
  ) {}

  /**
   * 打开或聚焦某个视图的作品列表页。
   * @param view 素材来源，或剧本视图。
   * @param request 需要页面处理的请求，如弹出新建作品表单。
   */
  show(view: WorkListView, request?: WorkListRequest): void {
    const key = panelKey(view);
    const existing = this.opened.get(view);
    if (existing !== undefined && this.panels.reveal(key)) {
      if (request !== undefined) {
        existing.panel?.postEvent(WORK_LIST_EVENTS.action, request);
      }
      return;
    }

    const { projects, works, stages, screenplays } = this.services;
    const entry: OpenedWorkList = { panel: undefined, pending: request };
    const router = new MessageRouter();
    registerWorkListHandlers(router, view, this.services, {
      takePending: () => {
        const taken = entry.pending;
        entry.pending = undefined;
        return taken;
      }
    });
    const openStage = (workId: number, stage: StageKind): void => entry.panel?.postEvent(WORK_LIST_EVENTS.openStage, { workId, stage });
    registerFormHandlers(
      router,
      new Map([
        ...createWorkFormCatalog({ projects, works, stages, onStarted: (workId) => openStage(workId, 'creative') }),
        ...createScreenplayFormCatalog({
          projects,
          works,
          screenplays,
          onStarted: (workId) => openStage(workId, 'screenplay'),
          onPicked: (workId) => entry.panel?.postEvent(WORK_LIST_EVENTS.startScreenplay, { workId })
        })
      ])
    );

    const panel = this.panels.open({
      key,
      viewType: WORK_LIST_VIEW_TYPE,
      title: WORK_LIST_TITLES[view],
      description: WORK_LIST_DESCRIPTIONS[view],
      styles: WORK_LIST_PAGE_RESOURCES.styles,
      scripts: WORK_LIST_PAGE_RESOURCES.scripts,
      router
    });
    entry.panel = panel;
    this.opened.set(view, entry);

    const notifyChanged = () => panel.postEvent(WORK_LIST_EVENTS.changed);
    const unsubscribes = [
      // 项目改名或删除（连同作品）也会影响列表。
      projects.onDidChangeProjects(notifyChanged),
      works.onDidChangeWorks(notifyChanged),
      stages.onDidChange((change) => {
        notifyChanged();
        panel.postEvent(STAGE_EVENTS.changed, { workId: change.workId, runId: change.runId });
      })
    ];
    panel.onDidClose(() => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      this.opened.delete(view);
    });
  }
}

/** 作品列表页的面板键。 */
function panelKey(view: WorkListView): string {
  return `work-list:${view}`;
}
