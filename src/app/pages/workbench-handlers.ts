// ------------------------------------------------------------------------
// 名称：workbench-handlers.ts
// 说明：生成工作台（P5）的请求处理：读取作品与可用模型清单、读取一集的镜头组与任务历史、提交生成（结果以右下角通知弹出）、重新分组与拆分合并镜头组、取消任务、采用某个结果版本、打开、导出、在文件夹中显示结果视频、尾帧截取相关（列出待截取的结果、把结果视频交给页面、保存尾帧、上报截取失败）；并提供分镜脚本阶段产出层需要的请求。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；打开文件由宿主注入的 openFile 完成；“编辑镜头 / 确认分镜脚本”复用阶段产出层，所以一并注册阶段请求。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { BindingService } from '../services/binding-service';
import { GenerationProfileService } from '../services/generation-profile-service';
import { GenerationService, SubmitResult } from '../services/generation-service';
import { ScreenplayService } from '../services/screenplay-service';
import { StageService } from '../services/stage-service';
import { StoryboardService } from '../services/storyboard-service';
import { WorkService } from '../services/work-service';
import { registerBindingHandlers } from './binding-handlers';
import { registerStageHandlers } from './stage-handlers';

/** 工作台使用的请求名称，需与 resources/workbench/workbench.js 一致。 */
export const WORKBENCH_REQUESTS = {
  catalog: 'workbench.catalog',
  episode: 'workbench.episode',
  profile: 'workbench.profile',
  saveProfile: 'workbench.saveProfile',
  submit: 'workbench.submit',
  regroup: 'workbench.regroup',
  splitGroup: 'workbench.splitGroup',
  mergeGroup: 'workbench.mergeGroup',
  cancel: 'workbench.cancel',
  selectResult: 'workbench.selectResult',
  openResult: 'workbench.openResult',
  exportResult: 'workbench.exportResult',
  revealResult: 'workbench.revealResult',
  pendingFrames: 'workbench.pendingFrames',
  resultVideo: 'workbench.resultVideo',
  saveFrame: 'workbench.saveFrame',
  frameFailed: 'workbench.frameFailed'
} as const;

/** 读给页面截取尾帧的结果视频大小上限（字节）：视频要以 Base64 形式通过消息传给页面。 */
const MAX_FRAME_SOURCE_BYTES = 200 * 1024 * 1024;

/** 宿主推送给工作台的事件名称：changed 要求刷新数据（任务或分镜脚本有变化）。 */
export const WORKBENCH_EVENTS = {
  changed: 'workbench.changed'
} as const;

/** 工作台依赖的服务。 */
export interface WorkbenchServices {
  readonly generation: GenerationService;
  readonly profiles: GenerationProfileService;
  readonly bindings: BindingService;
  readonly works: WorkService;
  readonly stages: StageService;
  readonly screenplays: ScreenplayService;
  readonly storyboards: StoryboardService;
}

/** 工作台依赖的宿主能力。 */
export interface WorkbenchHost {
  /** 用系统默认程序打开本机文件。 */
  readonly openFile: (absolutePath: string) => Promise<void>;
  /** 让用户选择位置并把文件复制过去；用户取消时返回 false。 */
  readonly exportFile: (absolutePath: string, suggestedName: string) => Promise<boolean>;
  /** 在系统文件管理器中显示文件。 */
  readonly revealFile: (absolutePath: string) => Promise<void>;
  /** 读取本机文件的全部内容。 */
  readonly readFile: (absolutePath: string) => Promise<Uint8Array>;
  /** 在 VS Code 右下角弹出通知。 */
  readonly notify: (level: NoticeLevel, message: string) => void;
}

/** 通知的级别。 */
export type NoticeLevel = 'info' | 'warning';

/**
 * 把提交结果整理成一条通知：已提交的组数、提醒与被拒绝的原因；有被拒绝的组时为警告级别。
 * @returns 没有任何内容可通知时返回 undefined。
 */
export function describeSubmitResult(result: SubmitResult): { readonly level: NoticeLevel; readonly message: string } | undefined {
  const lines: string[] = [];
  if (result.submitted.length > 0) {
    lines.push(`已提交 ${result.submitted.length} 个镜头组，生成需要几分钟，完成后会通知你。`);
  }
  for (const item of result.submitted) {
    for (const warning of item.warnings) lines.push(`第 ${item.seq} 组：${warning}`);
  }
  for (const item of result.rejected) {
    lines.push(`第 ${item.seq || item.groupId} 组未提交：${item.issues.join('；')}`);
  }
  if (lines.length === 0) {
    return undefined;
  }
  return { level: result.rejected.length > 0 ? 'warning' : 'info', message: lines.join('\n') };
}

/**
 * 在路由器上注册工作台的请求处理函数。
 * @param router 面板的请求路由器。
 * @param services 工作台依赖的服务。
 * @param host 宿主能力。
 */
export function registerWorkbenchHandlers(router: MessageRouter, services: WorkbenchServices, host: WorkbenchHost): void {
  const { generation, profiles, bindings, works, stages, screenplays, storyboards } = services;

  registerBindingHandlers(router, bindings);
  router.register(WORKBENCH_REQUESTS.catalog, () => generation.getCatalog());

  router.register(WORKBENCH_REQUESTS.episode, (payload) => {
    const record = readRecord(payload);
    return generation.getEpisode(readEntityId({ id: record.workId }, '作品'), readEntityId({ id: record.episodeId }, '集'));
  });

  router.register(WORKBENCH_REQUESTS.profile, (payload) => {
    const record = readRecord(payload);
    return profiles.getView(readEntityId({ id: record.workId }, '作品'), readEntityId({ id: record.episodeId }, '集'));
  });
  router.register(WORKBENCH_REQUESTS.saveProfile, (payload) => profiles.save(payload));

  router.register(WORKBENCH_REQUESTS.submit, async (payload) => {
    const result = await generation.submit(payload);
    const notice = describeSubmitResult(result);
    if (notice !== undefined) {
      host.notify(notice.level, notice.message);
    }
    return result;
  });
  router.register(WORKBENCH_REQUESTS.regroup, (payload) => {
    generation.regroup(payload);
    return { done: true };
  });
  router.register(WORKBENCH_REQUESTS.splitGroup, (payload) => {
    generation.splitGroup(payload);
    return { done: true };
  });
  router.register(WORKBENCH_REQUESTS.mergeGroup, (payload) => {
    generation.mergeGroup(payload);
    return { done: true };
  });

  router.register(WORKBENCH_REQUESTS.cancel, (payload) => generation.cancel(payload));
  router.register(WORKBENCH_REQUESTS.selectResult, (payload) => generation.selectResult(payload));

  router.register(WORKBENCH_REQUESTS.openResult, async (payload) => {
    await host.openFile(generation.getResultPath(payload));
    return { opened: true };
  });

  router.register(WORKBENCH_REQUESTS.exportResult, async (payload) => {
    const file = generation.getResultFile(payload);
    return { exported: await host.exportFile(file.path, file.suggestedName) };
  });

  router.register(WORKBENCH_REQUESTS.revealResult, async (payload) => {
    await host.revealFile(generation.getResultPath(payload));
    return { revealed: true };
  });

  router.register(WORKBENCH_REQUESTS.pendingFrames, () => generation.listPendingTailFrames());
  router.register(WORKBENCH_REQUESTS.resultVideo, async (payload) => {
    const data = await host.readFile(generation.getResultPath(payload));
    if (data.byteLength > MAX_FRAME_SOURCE_BYTES) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '结果视频过大，无法在工作台里截取尾帧。' });
    }
    return { mimeType: 'video/mp4', data: Buffer.from(data).toString('base64') };
  });
  router.register(WORKBENCH_REQUESTS.saveFrame, (payload) => generation.saveTailFrame(payload));
  router.register(WORKBENCH_REQUESTS.frameFailed, (payload) => generation.reportTailFrameFailure(payload));

  registerStageHandlers(
    router,
    { stages, screenplays, storyboards },
    (payload) => works.getWork(readEntityId({ id: readRecord(payload).workId }, '作品')).id
  );
}
