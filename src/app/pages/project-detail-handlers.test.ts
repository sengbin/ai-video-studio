// ------------------------------------------------------------------------
// 名称：project-detail-handlers.test.ts
// 说明：项目详情页请求处理的自动化测试：读取、待处理请求、创意产出请求的作品归属校验、名称确认删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库、真实的服务与脚本化的假文本生成端口，通过消息路由器发送请求。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { MessageRouter } from '../messaging/message-router';
import { createServiceFixture } from '../services/testing/service-fixture';
import { WorkListItem } from '../services/work-service';
import { PROJECT_DETAIL_REQUESTS, ProjectDetailRequest, registerProjectDetailHandlers } from './project-detail-handlers';
import { STAGE_REQUESTS } from './stage-handlers';

const PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };

/** 创建夹具：项目内两个作品，另有一个属于其他项目的作品。 */
function createFixture() {
  const fixture = createServiceFixture();
  const { projects, works } = fixture;
  const work = works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  const other = projects.createProject({ name: '项目乙' });
  const foreign = works.createWork(other.id, normalizeWorkCreation({ workName: '外来作品', kind: '单个短视频' }, 'text'));

  const state: { pending: ProjectDetailRequest | undefined } = { pending: undefined };
  const detailRouter = new MessageRouter();
  registerProjectDetailHandlers(detailRouter, fixture.project.id, fixture, {
    takePending: () => {
      const taken = state.pending;
      state.pending = undefined;
      return taken;
    }
  });
  const sendDetail = (name: string, payload?: unknown) => detailRouter.handle({ type: 'request', requestId: 1, name, payload });
  return { ...fixture, work, foreign, state, sendDetail };
}

test('详情页读取：返回项目与作品列表（含创意阶段状态）', async () => {
  const { database, sendDetail, work, stages, runner } = createFixture();
  try {
    await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();
    const response = await sendDetail(PROJECT_DETAIL_REQUESTS.load);
    assert.ok(response?.ok);
    const data = response.data as { project: { name: string }; works: WorkListItem[] };
    assert.equal(data.project.name, '项目甲');
    assert.deepEqual(data.works.map((item) => [item.name, item.creative.display, item.creative.version]), [['作品甲', 'pending', 1]]);
  } finally {
    database.close();
  }
});

test('详情页待处理请求：取走后不再返回', async () => {
  const { database, sendDetail, state } = createFixture();
  try {
    state.pending = { createSource: 'novel' };
    const first = await sendDetail(PROJECT_DETAIL_REQUESTS.takePending);
    assert.deepEqual(first?.ok && first.data, { request: { createSource: 'novel' } });
    const second = await sendDetail(PROJECT_DETAIL_REQUESTS.takePending);
    assert.deepEqual(second?.ok && second.data, { request: undefined });
  } finally {
    database.close();
  }
});

test('创意产出请求：只能访问本项目的作品', async () => {
  const { database, sendDetail, work, foreign, stages, runner } = createFixture();
  try {
    await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();

    const ok = await sendDetail(STAGE_REQUESTS.load, { workId: work.id });
    assert.ok(ok?.ok);
    assert.equal((ok.data as { work: { id: number } }).work.id, work.id);

    const denied = await sendDetail(STAGE_REQUESTS.load, { workId: foreign.id });
    assert.ok(denied && !denied.ok && denied.error.kind === 'validation');
    const missing = await sendDetail(STAGE_REQUESTS.load, { workId: 999 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    const absent = await sendDetail(STAGE_REQUESTS.load, {});
    assert.ok(absent && !absent.ok && absent.error.kind === 'validation');

    const run = stages.getCreativeView(work.id).run;
    const forged = await sendDetail(STAGE_REQUESTS.approve, { workId: foreign.id, id: run.id });
    assert.ok(forged && !forged.ok, '用外来作品的标识也不能操作本项目的版本');
    assert.equal(stages.getCreativeView(work.id).run.display, 'pending');
  } finally {
    database.close();
  }
});

test('删除作品：宿主校验确认名称；删除会先取消正在进行的生成；不能删除其他项目的作品', async () => {
  const { database, sendDetail, work, foreign, works, runs } = createFixture();
  try {
    const prepared = await sendDetail(PROJECT_DETAIL_REQUESTS.prepareDeleteWork, { id: work.id });
    assert.deepEqual(prepared?.ok && prepared.data, { name: '作品甲' });

    const wrong = await sendDetail(PROJECT_DETAIL_REQUESTS.deleteWork, { id: work.id, confirmName: '别的' });
    assert.ok(wrong && !wrong.ok && wrong.error.fieldErrors?.confirmName);
    assert.equal(works.getWork(work.id).name, '作品甲');

    const denied = await sendDetail(PROJECT_DETAIL_REQUESTS.deleteWork, { id: foreign.id, confirmName: '外来作品' });
    assert.ok(denied && !denied.ok);
    assert.equal(works.getWork(foreign.id).name, '外来作品');

    const right = await sendDetail(PROJECT_DETAIL_REQUESTS.deleteWork, { id: work.id, confirmName: '作品甲' });
    assert.deepEqual(right?.ok && right.data, { deleted: true, name: '作品甲' });
    assert.equal(works.listWorks(work.projectId).length, 0);
    assert.equal(runs.findRunning({ workId: work.id, stage: 'creative', episodeId: null }), undefined);
  } finally {
    database.close();
  }
});
