// ------------------------------------------------------------------------
// 名称：stage-handlers.ts
// 说明：阶段产出（P7）的请求处理：读取视图、确认采用、取消、重试、读取失败时的原始输出，以及创意章节与剧本正文、集、实体的编辑保存、重新抽取。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；产出在所属页面内以弹出层显示，请求载荷带 workId 与 stage，由所属页面提供的 resolveWorkId 校验作品归属；重新生成表单由页面用表单请求在弹出页面中完成。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { StageKind } from '../../domain/models/stage-run';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { ScreenplayService } from '../services/screenplay-service';
import { StageService } from '../services/stage-service';

/** 阶段产出使用的请求名称，需与 resources/stage 下的脚本一致。 */
export const STAGE_REQUESTS = {
  load: 'stage.load',
  approve: 'stage.approve',
  cancel: 'stage.cancel',
  retry: 'stage.retry',
  rawOutput: 'stage.rawOutput',
  saveChapter: 'stage.saveChapter',
  saveScreenplayText: 'stage.saveScreenplayText',
  saveEpisode: 'stage.saveEpisode',
  saveEntity: 'stage.saveEntity',
  reextract: 'stage.reextract'
} as const;

/** 宿主推送给阶段产出的事件名称，载荷为 { workId, runId }。 */
export const STAGE_EVENTS = {
  changed: 'stage.changed'
} as const;

/** 产出层目前支持的阶段。 */
const SUPPORTED_STAGES: readonly StageKind[] = ['creative', 'screenplay'];

/** 读取请求载荷中的阶段，必须是产出层支持的阶段。 */
function readStage(payload: unknown): StageKind {
  const stage = readRecord(payload ?? {}).stage;
  if (typeof stage !== 'string' || !SUPPORTED_STAGES.includes(stage as StageKind)) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '阶段无效。' });
  }
  return stage as StageKind;
}

/**
 * 在路由器上注册阶段产出的请求处理函数。
 * @param router 面板的请求路由器。
 * @param services 阶段服务与剧本服务。
 * @param resolveWorkId 从请求载荷中读取作品标识并校验它属于所属页面；不合法时抛出错误。
 */
export function registerStageHandlers(
  router: MessageRouter,
  services: { readonly stages: StageService; readonly screenplays: ScreenplayService },
  resolveWorkId: (payload: unknown) => number
): void {
  const { stages, screenplays } = services;

  /** 读取请求中的记录标识，并确认它属于请求指定的作品与阶段。 */
  const readOwnRunId = (payload: unknown): number => {
    const runId = readEntityId(payload, '版本');
    stages.assertRunBelongs(runId, resolveWorkId(payload), readStage(payload));
    return runId;
  };

  router.register(STAGE_REQUESTS.load, (payload) => {
    const stage = readStage(payload);
    const workId = resolveWorkId(payload);
    const runId = readRecord(payload ?? {}).id;
    const id = typeof runId === 'number' ? runId : undefined;
    return stage === 'screenplay' ? screenplays.getView(workId, id) : stages.getCreativeView(workId, id);
  });

  router.register(STAGE_REQUESTS.approve, (payload) => {
    stages.approve(readOwnRunId(payload));
    return { approved: true };
  });

  router.register(STAGE_REQUESTS.cancel, (payload) => {
    stages.cancel(readOwnRunId(payload));
    return { canceled: true };
  });

  router.register(STAGE_REQUESTS.retry, async (payload) => {
    await stages.retry(readOwnRunId(payload));
    return { retried: true };
  });

  router.register(STAGE_REQUESTS.rawOutput, (payload) => ({ text: stages.getRawOutput(readOwnRunId(payload)) }));

  router.register(STAGE_REQUESTS.saveChapter, (payload) => {
    stages.saveChapter(readOwnRunId(payload), payload);
    return { saved: true };
  });

  router.register(STAGE_REQUESTS.saveScreenplayText, (payload) => {
    screenplays.saveText(readOwnRunId(payload), payload);
    return { saved: true };
  });

  router.register(STAGE_REQUESTS.saveEpisode, (payload) => {
    screenplays.saveEpisode(readOwnRunId(payload), payload);
    return { saved: true };
  });

  router.register(STAGE_REQUESTS.saveEntity, (payload) => {
    screenplays.saveEntity(readOwnRunId(payload), payload);
    return { saved: true };
  });

  router.register(STAGE_REQUESTS.reextract, async (payload) => {
    await screenplays.reextract(readOwnRunId(payload));
    return { started: true };
  });
}
