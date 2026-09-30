// ------------------------------------------------------------------------
// 名称：stage-review-rules.ts
// 说明：阶段记录的确认规则：能否启动、确认采用、编辑后回到待确认、下游是否过期、展示状态。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数，不访问存储；规则来源 docs/ARCHITECTURE.md 6.3 与 docs/database-design.md 第 7 节。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { ReviewPatch, StageDisplayStatus, StageKind, StageRun } from '../models/stage-run';

/** 每个阶段依赖的上游阶段；创意阶段没有上游。 */
export const UPSTREAM_STAGE: Readonly<Record<StageKind, StageKind | null>> = {
  creative: null,
  screenplay: 'creative',
  storyboard_script: 'screenplay'
};

/** 阶段名称，用于提示文字。 */
export const STAGE_LABELS: Readonly<Record<StageKind, string>> = {
  creative: '创意',
  screenplay: '剧本',
  storyboard_script: '分镜脚本'
};

/** 抛出不属于具体字段的校验错误。 */
function fail(message: string): never {
  throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: message });
}

/**
 * 把生成状态与确认状态合并为界面展示状态。
 * @param run 阶段记录。
 */
export function toDisplayStatus(run: StageRun): StageDisplayStatus {
  if (run.status !== 'succeeded') {
    return run.status;
  }
  if (run.reviewStatus === 'pending') {
    return 'pending';
  }
  return run.isCurrent ? 'approved' : 'history';
}

/** 是否可以确认采用：生成成功且尚待确认。 */
export function canApprove(run: StageRun): boolean {
  return run.status === 'succeeded' && run.reviewStatus === 'pending';
}

/** 是否可以取消：仅运行中。 */
export function canCancel(run: StageRun): boolean {
  return run.status === 'running';
}

/** 是否可以重试：失败或已取消。 */
export function canRetry(run: StageRun): boolean {
  return run.status === 'failed' || run.status === 'canceled';
}

/**
 * 计算确认采用后的状态：已确认并成为当前版本。
 * @param run 待确认的阶段记录。
 * @param now 确认时间（ISO 8601）。
 * @throws ValidationError 记录不是“生成成功且待确认”。
 */
export function createApprovalPatch(run: StageRun, now: string): ReviewPatch {
  if (!canApprove(run)) {
    fail('只有生成成功且待确认的版本才能确认采用。');
  }
  return { reviewStatus: 'approved', isCurrent: true, revision: run.revision, approvedAt: now };
}

/**
 * 计算产出被编辑保存后的状态：修订号加 1，回到待确认且不再是当前版本。
 * @param run 被编辑产出所属的阶段记录。
 * @throws ValidationError 生成尚未成功，不能编辑产出。
 */
export function createEditPatch(run: StageRun): ReviewPatch {
  if (run.status !== 'succeeded') {
    fail('生成成功后才能编辑产出。');
  }
  return { reviewStatus: 'pending', isCurrent: false, revision: run.revision + 1, approvedAt: run.approvedAt };
}

/**
 * 判断下游记录相对上游是否已过期：上游被修改、不再是当前版本或已被删除。
 * @param run 下游阶段记录。
 * @param source 它依赖的上游记录；上游已被删除时为 undefined。
 */
export function isStale(run: StageRun, source: StageRun | undefined): boolean {
  if (UPSTREAM_STAGE[run.stage] === null) {
    return false;
  }
  if (source === undefined) {
    return true;
  }
  return source.revision !== run.sourceRevision || !source.isCurrent;
}

/** 启动阶段生成前需要检查的现状。 */
export interface StartCheck {
  readonly stage: StageKind;
  /** 上游阶段的当前版本；没有已确认版本时为 undefined。 */
  readonly upstream: StageRun | undefined;
  /** 同一目标正在运行的记录；没有时为 undefined。 */
  readonly running: StageRun | undefined;
}

/**
 * 校验能否启动阶段生成：同一目标不能重复运行，上游必须已确认。
 * @throws ValidationError 不满足启动条件。
 */
export function assertCanStart(check: StartCheck): void {
  if (check.running !== undefined) {
    fail(`${STAGE_LABELS[check.stage]}正在生成，请等待完成或先取消。`);
  }
  const upstreamStage = UPSTREAM_STAGE[check.stage];
  if (upstreamStage !== null && (check.upstream === undefined || !check.upstream.isCurrent)) {
    fail(`请先确认${STAGE_LABELS[upstreamStage]}。`);
  }
}
