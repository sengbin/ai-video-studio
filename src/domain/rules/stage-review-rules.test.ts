// ------------------------------------------------------------------------
// 名称：stage-review-rules.test.ts
// 说明：阶段确认规则的自动化测试：展示状态、确认采用、编辑回退、下游过期、启动条件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数测试，不依赖存储与 VS Code。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ValidationError } from '../errors';
import { StageRun } from '../models/stage-run';
import {
  assertCanStart,
  canApprove,
  canCancel,
  canRetry,
  createApprovalPatch,
  createEditPatch,
  isStale,
  toDisplayStatus
} from './stage-review-rules';

const NOW = '2026-01-01T00:00:00.000Z';

/** 构造一条阶段记录，默认是生成成功、待确认的创意记录。 */
function makeRun(overrides: Partial<StageRun> = {}): StageRun {
  return {
    id: 1,
    workId: 1,
    stage: 'creative',
    episodeId: null,
    input: {},
    sourceRunId: null,
    sourceRevision: null,
    modelInfo: null,
    version: 1,
    status: 'succeeded',
    reviewStatus: 'pending',
    isCurrent: false,
    revision: 1,
    progress: null,
    rawOutput: null,
    errorMessage: null,
    createdAt: NOW,
    finishedAt: NOW,
    approvedAt: null,
    appliedAt: null,
    ...overrides
  };
}

test('展示状态：把生成状态与确认状态合并', () => {
  assert.equal(toDisplayStatus(makeRun({ status: 'running' })), 'running');
  assert.equal(toDisplayStatus(makeRun({ status: 'failed' })), 'failed');
  assert.equal(toDisplayStatus(makeRun({ status: 'canceled' })), 'canceled');
  assert.equal(toDisplayStatus(makeRun()), 'pending');
  assert.equal(toDisplayStatus(makeRun({ reviewStatus: 'approved', isCurrent: true })), 'approved');
  assert.equal(toDisplayStatus(makeRun({ reviewStatus: 'approved', isCurrent: false })), 'history');
});

test('操作可用性：确认、取消、重试各自只在对应状态可用', () => {
  assert.equal(canApprove(makeRun()), true);
  assert.equal(canApprove(makeRun({ reviewStatus: 'approved', isCurrent: true })), false);
  assert.equal(canApprove(makeRun({ status: 'failed' })), false);
  assert.equal(canCancel(makeRun({ status: 'running' })), true);
  assert.equal(canCancel(makeRun()), false);
  assert.equal(canRetry(makeRun({ status: 'failed' })), true);
  assert.equal(canRetry(makeRun({ status: 'canceled' })), true);
  assert.equal(canRetry(makeRun()), false);
});

test('确认采用：变为已确认并成为当前版本，保持修订号', () => {
  const patch = createApprovalPatch(makeRun({ revision: 3 }), NOW);
  assert.deepEqual(patch, { reviewStatus: 'approved', isCurrent: true, revision: 3, approvedAt: NOW });
});

test('确认采用：只有生成成功且待确认的版本可以确认', () => {
  assert.throws(() => createApprovalPatch(makeRun({ status: 'running' }), NOW), ValidationError);
  assert.throws(() => createApprovalPatch(makeRun({ reviewStatus: 'approved', isCurrent: true }), NOW), ValidationError);
});

test('编辑产出：修订号加 1，已确认的版本回到待确认且不再是当前版本', () => {
  const approved = makeRun({ reviewStatus: 'approved', isCurrent: true, revision: 2, approvedAt: NOW });
  assert.deepEqual(createEditPatch(approved), {
    reviewStatus: 'pending',
    isCurrent: false,
    revision: 3,
    approvedAt: NOW
  });
  assert.deepEqual(createEditPatch(makeRun()), { reviewStatus: 'pending', isCurrent: false, revision: 2, approvedAt: null });
});

test('编辑产出：生成尚未成功时不允许', () => {
  assert.throws(() => createEditPatch(makeRun({ status: 'running' })), ValidationError);
  assert.throws(() => createEditPatch(makeRun({ status: 'failed' })), ValidationError);
});

test('下游过期：上游被修改、不再是当前版本或已被删除', () => {
  const upstream = makeRun({ id: 1, reviewStatus: 'approved', isCurrent: true, revision: 2 });
  const downstream = makeRun({ id: 2, stage: 'screenplay', sourceRunId: 1, sourceRevision: 2 });

  assert.equal(isStale(downstream, upstream), false);
  assert.equal(isStale(downstream, { ...upstream, revision: 3 }), true, '上游修订号变了');
  assert.equal(isStale(downstream, { ...upstream, isCurrent: false, reviewStatus: 'pending' }), true, '上游回到待确认');
  assert.equal(isStale(downstream, { ...upstream, isCurrent: false }), true, '上游被新版本取代');
  assert.equal(isStale(downstream, undefined), true, '上游已删除');
});

test('下游过期：创意阶段没有上游，永不过期', () => {
  assert.equal(isStale(makeRun(), undefined), false);
});

test('启动条件：同一目标正在生成时不能再启动', () => {
  assert.throws(
    () => assertCanStart({ stage: 'creative', upstream: undefined, running: makeRun({ status: 'running' }) }),
    ValidationError
  );
  assert.doesNotThrow(() => assertCanStart({ stage: 'creative', upstream: undefined, running: undefined }));
});

test('启动条件：剧本与分镜脚本需要上游已确认', () => {
  const approved = makeRun({ reviewStatus: 'approved', isCurrent: true });
  assert.throws(() => assertCanStart({ stage: 'screenplay', upstream: undefined, running: undefined }), /请先确认创意/);
  assert.throws(() => assertCanStart({ stage: 'screenplay', upstream: makeRun(), running: undefined }), /请先确认创意/);
  assert.doesNotThrow(() => assertCanStart({ stage: 'screenplay', upstream: approved, running: undefined }));
  assert.throws(
    () => assertCanStart({ stage: 'storyboard_script', upstream: undefined, running: undefined }),
    /请先确认剧本/
  );
});
