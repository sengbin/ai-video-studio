// ------------------------------------------------------------------------
// 名称：stage-handlers.test.ts
// 说明：阶段产出页请求处理的自动化测试：创意与剧本的读取视图、确认采用、编辑保存、版本归属校验。
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
  registerStageHandlers(router, fixture, () => work.id);
  const sendStage = (name: string, payload: object = {}, stage = 'creative') =>
    router.handle({ type: 'request', requestId: 1, name, payload: { stage, ...payload } });
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

test('剧本产出：读取视图、编辑正文、集、实体，重新抽取，确认采用；阶段不符的版本被拒绝', async () => {
  const { database, sendStage, work, stages, screenplays, runner, runs } = createFixture();
  try {
    const creative = await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();
    stages.approve(creative.id);
    const run = await screenplays.start(work.id, { maxEpisodeDurationSeconds: 60 });
    await runner.whenIdle();

    const loaded = await sendStage(STAGE_REQUESTS.load, {}, 'screenplay');
    assert.ok(loaded?.ok);
    assert.equal((loaded.data as { screenplay: { title: string } }).screenplay.title, '雨夜来客');

    const text = await sendStage(STAGE_REQUESTS.saveScreenplayText, { id: run.id, fullText: '新正文' }, 'screenplay');
    assert.ok(text?.ok);
    const episode = await sendStage(
      STAGE_REQUESTS.saveEpisode,
      { id: run.id, ref: 0, title: '集', synopsis: '梗概', screenplayText: '正文', targetDurationSeconds: '' },
      'screenplay'
    );
    assert.ok(episode?.ok);
    const entity = await sendStage(STAGE_REQUESTS.saveEntity, { id: run.id, ref: 0, name: '' }, 'screenplay');
    assert.ok(entity && !entity.ok && entity.error.fieldErrors?.name);

    const reextract = await sendStage(STAGE_REQUESTS.reextract, { id: run.id }, 'screenplay');
    assert.ok(reextract?.ok);
    await runner.whenIdle();
    assert.equal(screenplays.getView(work.id).episodes.length, 1);

    const approved = await sendStage(STAGE_REQUESTS.approve, { id: run.id }, 'screenplay');
    assert.ok(approved?.ok);
    assert.equal(runs.findById(run.id)?.reviewStatus, 'approved');

    // 创意阶段的版本标识不能用在剧本阶段的请求上，未知阶段被拒绝。
    const wrongStage = await sendStage(STAGE_REQUESTS.approve, { id: creative.id }, 'screenplay');
    assert.ok(wrongStage && !wrongStage.ok && wrongStage.error.kind === 'not-found');
    const unknown = await sendStage(STAGE_REQUESTS.load, {}, 'bogus');
    assert.ok(unknown && !unknown.ok && unknown.error.kind === 'validation');
  } finally {
    database.close();
  }
});

test('分镜脚本产出：按集读取视图、编辑镜头、确认采用；缺少集标识或集不符的请求被拒绝', async () => {
  const { database, sendStage, work, stages, screenplays, storyboards, runner } = createFixture();
  try {
    const creative = await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();
    stages.approve(creative.id);
    const screenplay = await screenplays.start(work.id, { maxEpisodeDurationSeconds: 60 });
    await runner.whenIdle();
    stages.approve(screenplay.id);
    const [episode] = storyboards.listEpisodeStatuses(work.id);
    const [run] = await storyboards.start(work.id, [episode.episodeId], {});
    await runner.whenIdle();
    const send = (name: string, payload: object = {}) => sendStage(name, { episodeId: episode.episodeId, ...payload }, 'storyboard_script');

    const noEpisode = await sendStage(STAGE_REQUESTS.load, {}, 'storyboard_script');
    assert.ok(noEpisode && !noEpisode.ok && noEpisode.error.kind === 'validation');
    const missingEpisode = await sendStage(STAGE_REQUESTS.load, { episodeId: 9999 }, 'storyboard_script');
    assert.ok(missingEpisode && !missingEpisode.ok && missingEpisode.error.kind === 'not-found');

    const loaded = await send(STAGE_REQUESTS.load);
    assert.ok(loaded?.ok);
    const view = loaded.data as { shots: Array<{ id: number; action: string }>; run: { display: string }; episode: { seq: number } };
    assert.equal(view.run.display, 'pending');
    assert.equal(view.shots.length, 2);

    const base = { id: run.id, ref: view.shots[0].id, action: '新画面', durationSeconds: '3', firstFrameMode: 'none', entityIds: [], sounds: [] };
    const saved = await send(STAGE_REQUESTS.saveShot, base);
    assert.ok(saved?.ok);
    assert.equal(storyboards.getView(work.id, episode.episodeId).shots[0].action, '新画面');
    const invalid = await send(STAGE_REQUESTS.saveShot, { ...base, action: '' });
    assert.ok(invalid && !invalid.ok && invalid.error.fieldErrors?.action);

    // 别的集的标识不能操作这一集的版本。
    const wrongEpisode = await sendStage(STAGE_REQUESTS.approve, { id: run.id, episodeId: episode.episodeId + 100 }, 'storyboard_script');
    assert.ok(wrongEpisode && !wrongEpisode.ok && wrongEpisode.error.kind === 'not-found');

    const approved = await send(STAGE_REQUESTS.approve, { id: run.id });
    assert.ok(approved?.ok);
    assert.equal(storyboards.getView(work.id, episode.episodeId).run.display, 'approved');
  } finally {
    database.close();
  }
});
