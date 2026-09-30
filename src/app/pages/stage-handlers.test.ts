// ------------------------------------------------------------------------
// 名称：stage-handlers.test.ts
// 说明：创意阶段产出页请求处理的自动化测试：读取视图、确认采用、保存章节、版本归属校验。
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
import { STAGE_REQUESTS, registerStageHandlers } from './stage-handlers';

const PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };

/** 创建夹具：页面绑定“作品甲”，另有一个属于其他项目的作品。 */
function createFixture() {
  const fixture = createServiceFixture();
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  const other = fixture.projects.createProject({ name: '项目乙' });
  const foreign = fixture.works.createWork(other.id, normalizeWorkCreation({ workName: '外来作品', kind: '单个短视频' }, 'text'));
  const router = new MessageRouter();
  registerStageHandlers(router, fixture.stages, () => work.id);
  const sendStage = (name: string, payload?: unknown) => router.handle({ type: 'request', requestId: 1, name, payload });
  return { ...fixture, work, foreign, sendStage };
}
test('产出页：读取视图、确认采用、保存章节、读取版本', async () => {
  const { database, sendStage, work, stages, runner } = createFixture();
  try {
    const missing = await sendStage(STAGE_REQUESTS.load);
    assert.ok(missing && !missing.ok && missing.error.kind === 'not-found');

    const run = await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();

    const loaded = await sendStage(STAGE_REQUESTS.load);
    assert.ok(loaded?.ok);
    assert.equal((loaded.data as { run: { display: string } }).run.display, 'pending');
    const byId = await sendStage(STAGE_REQUESTS.load, { id: run.id });
    assert.ok(byId?.ok);

    const saved = await sendStage(STAGE_REQUESTS.saveChapter, { id: run.id, seq: 1, title: '新标题', content: '新正文' });
    assert.ok(saved?.ok);
    assert.equal(stages.getCreativeView(work.id).chapters[0].title, '新标题');

    const invalid = await sendStage(STAGE_REQUESTS.saveChapter, { id: run.id, seq: 1, title: '', content: '正文' });
    assert.ok(invalid && !invalid.ok && invalid.error.fieldErrors?.title);

    const approved = await sendStage(STAGE_REQUESTS.approve, { id: run.id });
    assert.ok(approved?.ok);
    assert.equal(stages.getCreativeView(work.id).run.display, 'approved');
    const again = await sendStage(STAGE_REQUESTS.approve, { id: run.id });
    assert.ok(again && !again.ok && again.error.kind === 'validation');
  } finally {
    database.close();
  }
});

test('产出页：不属于本作品的版本被拒绝；没有生成时取消返回错误', async () => {
  const { database, sendStage, foreign, stages, runner, work } = createFixture();
  try {
    const foreignRun = await stages.startCreative(foreign.id, PARAMS);
    await runner.whenIdle();
    await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();

    const denied = await sendStage(STAGE_REQUESTS.approve, { id: foreignRun.id });
    assert.ok(denied && !denied.ok && denied.error.kind === 'not-found');
    const invalidId = await sendStage(STAGE_REQUESTS.rawOutput, { id: 'x' });
    assert.ok(invalidId && !invalidId.ok && invalidId.error.kind === 'validation');

    const latest = stages.getCreativeView(work.id).run.id;
    const cancel = await sendStage(STAGE_REQUESTS.cancel, { id: latest });
    assert.ok(cancel && !cancel.ok && cancel.error.kind === 'validation');
    const raw = await sendStage(STAGE_REQUESTS.rawOutput, { id: latest });
    assert.deepEqual(raw?.ok && raw.data, { text: '' });
  } finally {
    database.close();
  }
});
