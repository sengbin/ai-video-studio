// ------------------------------------------------------------------------
// 名称：stage-handlers.ts
// 说明：创意阶段产出（P7）的请求处理：读取视图、确认采用、取消、重试、保存人工编辑的章节、读取失败时的原始输出。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；产出在所属页面内以弹出层显示，请求载荷带 workId，由所属页面提供的 resolveWorkId 校验作品归属；重新生成表单由页面用表单请求在弹出页面中完成。
// ------------------------------------------------------------------------

import { NotFoundError } from '../../domain/errors';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { StageService } from '../services/stage-service';

/** 阶段产出使用的请求名称，需与 resources/stage/stage.js 一致。 */
export const STAGE_REQUESTS = {
  load: 'stage.load',
  approve: 'stage.approve',
  cancel: 'stage.cancel',
  retry: 'stage.retry',
  saveChapter: 'stage.saveChapter',
  rawOutput: 'stage.rawOutput'
} as const;

/** 宿主推送给阶段产出的事件名称，载荷为 { workId, runId }。 */
export const STAGE_EVENTS = {
  changed: 'stage.changed'
} as const;

/**
 * 在路由器上注册阶段产出的请求处理函数。
 * @param router 面板的请求路由器。
 * @param stages 阶段服务。
 * @param resolveWorkId 从请求载荷中读取作品标识并校验它属于所属页面；不合法时抛出错误。
 */
export function registerStageHandlers(
  router: MessageRouter,
  stages: StageService,
  resolveWorkId: (payload: unknown) => number
): void {
  /** 读取请求中的记录标识，并确认它属于请求指定的作品。 */
  const readOwnRunId = (payload: unknown): number => {
    const workId = resolveWorkId(payload);
    const runId = readEntityId(payload, '版本');
    if (stages.getCreativeView(workId, runId).run.id !== runId) {
      throw new NotFoundError('版本不存在。');
    }
    return runId;
  };

  router.register(STAGE_REQUESTS.load, (payload) => {
    const workId = resolveWorkId(payload);
    const runId = readRecord(payload ?? {}).id;
    return stages.getCreativeView(workId, typeof runId === 'number' ? runId : undefined);
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

  router.register(STAGE_REQUESTS.saveChapter, (payload) => {
    const runId = readOwnRunId(payload);
    stages.saveChapter(runId, payload);
    return { saved: true };
  });

  router.register(STAGE_REQUESTS.rawOutput, (payload) => ({ text: stages.getRawOutput(readOwnRunId(payload)) }));
}
