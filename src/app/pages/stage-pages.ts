// ------------------------------------------------------------------------
// 名称：stage-pages.ts
// 说明：阶段产出页（P7）的入口：每个作品的创意阶段一个面板，重复打开时聚焦；阶段数据变化时推送给页面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求处理在 stage-handlers.ts；页面内弹出“重新生成”表单，因此注册创意表单目录；目前只有创意阶段，剧本、分镜脚本沿用同样方式扩展。
// ------------------------------------------------------------------------

import { registerFormHandlers } from '../forms/form-handlers';
import { createWorkFormCatalog } from '../forms/work-form';
import { MessageRouter } from '../messaging/message-router';
import { STAGE_PAGE_RESOURCES } from '../panels/page-resources';
import { PanelManager } from '../panels/panel-manager';
import { ProjectService } from '../services/project-service';
import { StageService } from '../services/stage-service';
import { WorkService } from '../services/work-service';
import { STAGE_EVENTS, registerStageHandlers } from './stage-handlers';

const STAGE_VIEW_TYPE = 'aiVideoStudio.creativeStage';
const CREATIVE_STAGE_TITLE_SUFFIX = '创意';

/** 阶段产出页的入口集合。 */
export class StagePages {
  constructor(
    private readonly services: { readonly projects: ProjectService; readonly works: WorkService; readonly stages: StageService },
    private readonly panels: PanelManager
  ) {}

  /**
   * 打开或聚焦作品的创意阶段产出页。
   * @param workId 作品标识。
   * @throws NotFoundError 作品不存在。
   */
  showCreative(workId: number): void {
    const key = `creative-stage:${workId}`;
    if (this.panels.reveal(key)) {
      return;
    }

    const { projects, works, stages } = this.services;
    const work = works.getWork(workId);
    const router = new MessageRouter();
    registerStageHandlers(router, workId, stages);
    // 页面已经打开，重新生成开始后由阶段变化事件刷新，不需要再打开页面。
    registerFormHandlers(router, createWorkFormCatalog({ projects, works, stages, onStarted: () => undefined }));

    const panel = this.panels.open({
      key,
      viewType: STAGE_VIEW_TYPE,
      title: `${work.name} › ${CREATIVE_STAGE_TITLE_SUFFIX}`,
      styles: STAGE_PAGE_RESOURCES.styles,
      scripts: STAGE_PAGE_RESOURCES.scripts,
      router
    });
    const unsubscribe = stages.onDidChange((change) => {
      if (change.workId === workId) {
        panel.postEvent(STAGE_EVENTS.changed, { runId: change.runId });
      }
    });
    // 作品被删除（单独删除，或随所属项目一起删除）后，它的产出页已经没有意义，自动关闭。
    const closeIfWorkGone = () => {
      if (works.findWork(workId) === undefined) {
        panel.close();
      }
    };
    const unsubscribeWorks = works.onDidChangeWorks(closeIfWorkGone);
    const unsubscribeProjects = projects.onDidChangeProjects(closeIfWorkGone);
    panel.onDidClose(() => {
      unsubscribe();
      unsubscribeWorks();
      unsubscribeProjects();
    });
  }
}
