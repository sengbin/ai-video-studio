// ------------------------------------------------------------------------
// 名称：workbench-handlers.ts
// 说明：生成工作台（P5）的请求处理：读取作品与可用模型清单、读取一集的镜头与任务历史、提交生成、取消任务、用系统播放器打开结果视频；并提供分镜脚本阶段产出层需要的请求。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；打开文件由宿主注入的 openFile 完成；“编辑镜头 / 确认分镜脚本”复用阶段产出层，所以一并注册阶段请求。
// ------------------------------------------------------------------------

import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { GenerationService } from '../services/generation-service';
import { ScreenplayService } from '../services/screenplay-service';
import { StageService } from '../services/stage-service';
import { StoryboardService } from '../services/storyboard-service';
import { WorkService } from '../services/work-service';
import { registerStageHandlers } from './stage-handlers';

/** 工作台使用的请求名称，需与 resources/workbench/workbench.js 一致。 */
export const WORKBENCH_REQUESTS = {
  catalog: 'workbench.catalog',
  episode: 'workbench.episode',
  submit: 'workbench.submit',
  cancel: 'workbench.cancel',
  openResult: 'workbench.openResult'
} as const;

/** 宿主推送给工作台的事件名称：changed 要求刷新数据（任务或分镜脚本有变化）。 */
export const WORKBENCH_EVENTS = {
  changed: 'workbench.changed'
} as const;

/** 工作台依赖的服务。 */
export interface WorkbenchServices {
  readonly generation: GenerationService;
  readonly works: WorkService;
  readonly stages: StageService;
  readonly screenplays: ScreenplayService;
  readonly storyboards: StoryboardService;
}

/** 工作台依赖的宿主能力。 */
export interface WorkbenchHost {
  /** 用系统默认程序打开本机文件。 */
  readonly openFile: (absolutePath: string) => Promise<void>;
}

/**
 * 在路由器上注册工作台的请求处理函数。
 * @param router 面板的请求路由器。
 * @param services 工作台依赖的服务。
 * @param host 宿主能力。
 */
export function registerWorkbenchHandlers(router: MessageRouter, services: WorkbenchServices, host: WorkbenchHost): void {
  const { generation, works, stages, screenplays, storyboards } = services;

  router.register(WORKBENCH_REQUESTS.catalog, () => generation.getCatalog());

  router.register(WORKBENCH_REQUESTS.episode, (payload) => {
    const record = readRecord(payload);
    return generation.getEpisode(readEntityId({ id: record.workId }, '作品'), readEntityId({ id: record.episodeId }, '集'));
  });

  router.register(WORKBENCH_REQUESTS.submit, (payload) => generation.submit(payload));

  router.register(WORKBENCH_REQUESTS.cancel, (payload) => generation.cancel(payload));

  router.register(WORKBENCH_REQUESTS.openResult, async (payload) => {
    await host.openFile(generation.getResultPath(payload));
    return { opened: true };
  });

  registerStageHandlers(
    router,
    { stages, screenplays, storyboards },
    (payload) => works.getWork(readEntityId({ id: readRecord(payload).workId }, '作品')).id
  );
}
