// ------------------------------------------------------------------------
// 名称：project-detail-handlers.test.ts
// 说明：项目详情层请求处理的自动化测试：读取、创意产出请求的作品校验、名称确认删除及其项目归属校验。
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
import { PROJECT_DETAIL_REQUESTS, registerProjectDetailHandlers } from './project-detail-handlers';
import { STAGE_REQUESTS } from './stage-handlers';

const PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };

/** 创建夹具：项目内两个作品，另有一个属于其他项目的作品。 */
function createFixture() {
  const fixture = createServiceFixture();
  const { projects, works } = fixture;
  const work = works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  const other = projects.createProject({ name: '项目乙' });
  const foreign = works.createWork(other.id, normalizeWorkCreation({ workName: '外来作品', kind: '单个短视频' }, 'text'));

  const detailRouter = new MessageRouter();
  registerProjectDetailHandlers(detailRouter, fixture);
  const sendDetail = (name: string, payload?: unknown) => detailRouter.handle({ type: 'request', requestId: 1, name, payload });
  return { ...fixture, work, other, foreign, sendDetail };
}

test('详情层读取：按请求的项目返回项目与作品列表（含创意阶段状态），项目标识不合法或不存在时返回错误', async () => {
  const { database, sendDetail, work, other, stages, runner } = createFixture();
  try {
    await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();
    const response = await sendDetail(PROJECT_DETAIL_REQUESTS.load, { projectId: work.projectId });
    assert.ok(response?.ok);
    const data = response.data as { project: { name: string }; works: WorkListItem[] };
    assert.equal(data.project.name, '项目甲');
    assert.deepEqual(data.works.map((item) => [item.name, item.creative.display, item.creative.version]), [['作品甲', 'pending', 1]]);

    const otherResponse = await sendDetail(PROJECT_DETAIL_REQUESTS.load, { projectId: other.id });
    assert.ok(otherResponse?.ok);
    assert.deepEqual((otherResponse.data as { works: WorkListItem[] }).works.map((item) => item.name), ['外来作品']);

    const absent = await sendDetail(PROJECT_DETAIL_REQUESTS.load, {});
    assert.ok(absent && !absent.ok && absent.error.kind === 'validation');
    const missing = await sendDetail(PROJECT_DETAIL_REQUESTS.load, { projectId: 999 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
  } finally {
    database.close();
  }
});

test('创意产出请求：作品不存在或缺少作品标识时返回错误，版本必须属于请求指定的作品', async () => {
  const { database, sendDetail, work, foreign, stages, runner } = createFixture();
  try {
    await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();

    const ok = await sendDetail(STAGE_REQUESTS.load, { workId: work.id });
    assert.ok(ok?.ok);
    assert.equal((ok.data as { work: { id: number } }).work.id, work.id);

    const missing = await sendDetail(STAGE_REQUESTS.load, { workId: 999 });
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');
    const absent = await sendDetail(STAGE_REQUESTS.load, {});
    assert.ok(absent && !absent.ok && absent.error.kind === 'validation');

    const run = stages.getCreativeView(work.id).run;
    const forged = await sendDetail(STAGE_REQUESTS.approve, { workId: foreign.id, id: run.id });
    assert.ok(forged && !forged.ok, '用其他作品的标识不能操作这个作品的版本');
    assert.equal(stages.getCreativeView(work.id).run.display, 'pending');
  } finally {
    database.close();
  }
});

test('删除作品：宿主校验确认名称；删除会先取消正在进行的生成；作品必须属于请求指定的项目', async () => {
  const { database, sendDetail, work, foreign, works, runs } = createFixture();
  const projectId = work.projectId;
  try {
    const prepared = await sendDetail(PROJECT_DETAIL_REQUESTS.prepareDeleteWork, { projectId, id: work.id });
    assert.deepEqual(prepared?.ok && prepared.data, { name: '作品甲' });

    const wrongProject = await sendDetail(PROJECT_DETAIL_REQUESTS.prepareDeleteWork, { projectId: foreign.projectId, id: work.id });
    assert.ok(wrongProject && !wrongProject.ok && wrongProject.error.kind === 'validation');

    const wrong = await sendDetail(PROJECT_DETAIL_REQUESTS.deleteWork, { projectId, id: work.id, confirmName: '别的' });
    assert.ok(wrong && !wrong.ok && wrong.error.fieldErrors?.confirmName);
    assert.equal(works.getWork(work.id).name, '作品甲');

    const denied = await sendDetail(PROJECT_DETAIL_REQUESTS.deleteWork, { projectId, id: foreign.id, confirmName: '外来作品' });
    assert.ok(denied && !denied.ok);
    assert.equal(works.getWork(foreign.id).name, '外来作品');

    const right = await sendDetail(PROJECT_DETAIL_REQUESTS.deleteWork, { projectId, id: work.id, confirmName: '作品甲' });
    assert.deepEqual(right?.ok && right.data, { deleted: true, name: '作品甲' });
    assert.equal(works.listWorks(work.projectId).length, 0);
    assert.equal(runs.findRunning({ workId: work.id, stage: 'creative', episodeId: null }), undefined);
  } finally {
    database.close();
  }
});
