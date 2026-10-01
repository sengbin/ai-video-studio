// ------------------------------------------------------------------------
// 名称：storyboard-service.test.ts
// 说明：分镜脚本阶段应用服务的自动化测试：生成、视图、多集、编辑保存、确认与上游变更、失败后继续。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、真实的执行器与三个阶段的工作流，以及脚本化的假文本生成端口。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, TextGenerationError, ValidationError } from '../../domain/errors';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { Responder, standardResponder } from '../stages/testing/scripted-text';
import { createServiceFixture } from './testing/service-fixture';

const CREATIVE_PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };
const SCREENPLAY_PARAMS = { maxEpisodeDurationSeconds: '60', maxEpisodes: '3' };

/** 创建夹具与作品，生成并确认创意；withScreenplay 为 true 时再生成并确认剧本。 */
async function createFixture(kind: '单个短视频' | '多集短片' = '单个短视频', withScreenplay = true, responder: Responder = standardResponder) {
  const fixture = createServiceFixture(responder);
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind }, 'text'));
  const creative = await fixture.stages.startCreative(work.id, CREATIVE_PARAMS);
  await fixture.runner.whenIdle();
  fixture.stages.approve(creative.id);
  let screenplay;
  if (withScreenplay) {
    screenplay = await fixture.screenplays.start(work.id, SCREENPLAY_PARAMS);
    await fixture.runner.whenIdle();
    fixture.stages.approve(screenplay.id);
  }
  return { ...fixture, work, creative, screenplay };
}

/** 第一个集的标识。 */
function firstEpisodeId(fixture: Awaited<ReturnType<typeof createFixture>>): number {
  return fixture.storyboards.listEpisodeStatuses(fixture.work.id)[0].episodeId;
}

test('生成：剧本未确认时拒绝；确认后为这一集生成镜头、出场实体与声音，待确认', async () => {
  const early = await createFixture('单个短视频', false);
  try {
    assert.throws(() => early.storyboards.assertCanStart(early.work.id), ValidationError);
    await assert.rejects(early.storyboards.start(early.work.id, [1], {}), /请先确认剧本/);
    assert.equal(early.storyboards.getSummary(early.work.id).canStart, false);
  } finally {
    early.database.close();
  }

  const fixture = await createFixture();
  try {
    const episodeId = firstEpisodeId(fixture);
    const [run] = await fixture.storyboards.start(fixture.work.id, [episodeId], {});
    await fixture.runner.whenIdle();

    const view = fixture.storyboards.getView(fixture.work.id, episodeId);
    assert.equal(view.run.id, run.id);
    assert.equal(view.run.display, 'pending');
    assert.deepEqual(view.episode, { id: episodeId, seq: 1, title: '作品甲' });
    assert.equal(view.params?.continuity, 'ai');
    assert.equal(view.shots.length, 2);
    assert.equal(view.totalSeconds, 8);
    assert.equal(view.stale, false);
    assert.deepEqual(view.actions, { canApprove: true, canCancel: false, canRetry: false, canEdit: true, editNeedsConfirm: false });

    const names = new Map(view.entities.map((entity) => [entity.id, entity.name]));
    assert.deepEqual(view.shots[0].entityIds.map((id) => names.get(id)), ['灯塔']);
    assert.deepEqual(view.shots[1].entityIds.map((id) => names.get(id)), ['守夜人'], '老陈是守夜人的别名');
    assert.deepEqual(view.shots.map((shot) => shot.firstFrameMode), ['none', 'prev_tail']);
    assert.equal(view.shots[1].sounds[0].kind, 'dialogue');
    assert.equal(names.get(view.shots[1].sounds[0].speakerEntityId ?? 0), '守夜人');

    // 请求中带有剧本、实体清单与项目风格。
    const request = fixture.text.requests.at(-1);
    assert.ok(request?.user.includes('今晚会下雨') && request.user.includes('角色：守夜人（别名：老陈）'));
    assert.ok(request?.user.includes('没有指定'), '项目没有设置风格');
    assert.equal(fixture.storyboards.getLastParams(fixture.work.id)?.audioMode, 'native');
  } finally {
    fixture.database.close();
  }
});

test('生成：连贯策略与无声参数裁剪输出工具，并写入输入快照', async () => {
  const fixture = await createFixture();
  try {
    const episodeId = firstEpisodeId(fixture);
    await fixture.storyboards.start(fixture.work.id, [episodeId], { continuity: '尾帧接首帧', audioMode: '无声', visualStyle: '水彩' });
    await fixture.runner.whenIdle();
    const schema = JSON.stringify(fixture.text.requests.at(-1)?.tool.inputSchema);
    assert.ok(!schema.includes('"firstFrameMode"') && !schema.includes('"sounds"'));
    assert.ok(fixture.text.requests.at(-1)?.user.includes('水彩'));

    const view = fixture.storyboards.getView(fixture.work.id, episodeId);
    assert.deepEqual(view.shots.map((shot) => shot.firstFrameMode), ['none', 'prev_tail']);
    assert.deepEqual(view.shots.map((shot) => shot.sounds.length), [0, 0]);
    assert.deepEqual(view.params?.audioElements, []);
  } finally {
    fixture.database.close();
  }
});

test('生成：参数不合法时不创建记录；集必须属于作品；正在生成的集不能重复启动', async () => {
  const fixture = await createFixture();
  try {
    const episodeId = firstEpisodeId(fixture);
    await assert.rejects(fixture.storyboards.start(fixture.work.id, [episodeId], { maxShots: '0' }), ValidationError);
    await assert.rejects(fixture.storyboards.start(fixture.work.id, [9999], {}), /不属于该作品/);
    await assert.rejects(fixture.storyboards.start(fixture.work.id, [], {}), /请选择要生成的集/);
    assert.equal(fixture.runs.listVersions({ workId: fixture.work.id, stage: 'storyboard_script', episodeId }).length, 0);

    await fixture.storyboards.start(fixture.work.id, [episodeId], {});
    await assert.rejects(fixture.storyboards.start(fixture.work.id, [episodeId], {}), /正在生成/);
    await fixture.runner.whenIdle();
  } finally {
    fixture.database.close();
  }
});

test('多集：一次为所选集各生成一份，状态按集汇总，只有未选的集没有记录', async () => {
  const fixture = await createFixture('多集短片');
  try {
    const statuses = fixture.storyboards.listEpisodeStatuses(fixture.work.id);
    assert.equal(statuses.length, 2);
    assert.ok(statuses.every((status) => status.display === 'none'));

    const runs = await fixture.storyboards.start(fixture.work.id, [statuses[0].episodeId], {});
    assert.equal(runs.length, 1);
    await fixture.runner.whenIdle();
    const all = await fixture.storyboards.start(fixture.work.id, statuses.map((status) => status.episodeId), {});
    assert.equal(all.length, 2);
    await fixture.runner.whenIdle();

    const after = fixture.storyboards.listEpisodeStatuses(fixture.work.id);
    assert.deepEqual(after.map((status) => [status.seq, status.version, status.display, status.shotCount]), [
      [1, 2, 'pending', 2],
      [2, 1, 'pending', 2]
    ]);
    fixture.stages.approve(after[0].runId ?? 0);
    assert.deepEqual(fixture.storyboards.getSummary(fixture.work.id), { canStart: true, episodes: 2, approved: 1, started: 2 });
    assert.deepEqual(fixture.screenplays.getView(fixture.work.id).downstreamEpisodes, [1, 2]);

    // 一集的记录不能用另一集的标识操作。
    const second = after[1];
    assert.throws(() => fixture.stages.assertRunBelongs(second.runId ?? 0, fixture.work.id, 'storyboard_script', after[0].episodeId), NotFoundError);
    fixture.stages.assertRunBelongs(second.runId ?? 0, fixture.work.id, 'storyboard_script', second.episodeId);
  } finally {
    fixture.database.close();
  }
});

test('编辑：保存镜头与声音后回到待确认；已确认的版本编辑后需要重新确认；非法内容被拒绝', async () => {
  const fixture = await createFixture();
  try {
    const episodeId = firstEpisodeId(fixture);
    const [run] = await fixture.storyboards.start(fixture.work.id, [episodeId], {});
    await fixture.runner.whenIdle();
    fixture.stages.approve(run.id);

    let view = fixture.storyboards.getView(fixture.work.id, episodeId);
    assert.equal(view.run.display, 'approved');
    assert.equal(view.actions.editNeedsConfirm, true);
    const [first, second] = view.shots;
    const base = { ref: second.id, action: second.action, durationSeconds: 5, firstFrameMode: 'none', entityIds: second.entityIds, sounds: [] };

    fixture.storyboards.saveShot(run.id, { ...base, action: '守夜人关掉灯', sounds: [{ kind: 'sfx', text: '开关声', durationSeconds: '1' }] });
    view = fixture.storyboards.getView(fixture.work.id, episodeId);
    assert.equal(view.run.display, 'pending');
    assert.equal(view.shots[1].action, '守夜人关掉灯');
    assert.equal(view.shots[1].durationSeconds, 5);
    assert.equal(view.shots[1].firstFrameMode, 'none');
    assert.deepEqual(view.shots[1].sounds.map((sound) => [sound.kind, sound.text, sound.durationSeconds]), [['sfx', '开关声', 1]]);
    assert.equal(view.totalSeconds, 9);
    assert.equal(fixture.runs.findById(run.id)?.revision, 2);

    assert.throws(() => fixture.storyboards.saveShot(run.id, { ...base, ref: first.id, firstFrameMode: 'prev_tail' }), ValidationError);
    assert.throws(() => fixture.storyboards.saveShot(run.id, { ...base, action: '' }), ValidationError);
    assert.throws(() => fixture.storyboards.saveShot(run.id, { ...base, ref: 99999 }), NotFoundError);
    assert.equal(fixture.runs.findById(run.id)?.revision, 2, '被拒绝的编辑不改变修订号');
  } finally {
    fixture.database.close();
  }
});

test('上游变更：剧本被修改或重新生成后，分镜脚本显示“上游已变更”', async () => {
  const fixture = await createFixture();
  try {
    const episodeId = firstEpisodeId(fixture);
    const [run] = await fixture.storyboards.start(fixture.work.id, [episodeId], {});
    await fixture.runner.whenIdle();
    fixture.stages.approve(run.id);
    assert.equal(fixture.storyboards.getView(fixture.work.id, episodeId).stale, false);

    const screenplayView = fixture.screenplays.getView(fixture.work.id);
    fixture.screenplays.saveText(screenplayView.run.id, { fullText: '改过的剧本' });
    assert.equal(fixture.storyboards.getView(fixture.work.id, episodeId).stale, true);
    assert.equal(fixture.storyboards.listEpisodeStatuses(fixture.work.id)[0].stale, true);
  } finally {
    fixture.database.close();
  }
});

test('失败后继续：输出不合规时记录失败并保留原始输出，重试成功后写入镜头', async () => {
  let calls = 0;
  const responder: Responder = (request) => {
    if (request.user.includes('# 任务：生成分镜脚本') && ++calls === 1) {
      return { shots: [{ action: '没有提示词', durationSeconds: 3, entities: [{ kind: 'character', name: '路人' }] }] };
    }
    return standardResponder(request);
  };
  const fixture = await createFixture('单个短视频', true, responder);
  try {
    const episodeId = firstEpisodeId(fixture);
    const [run] = await fixture.storyboards.start(fixture.work.id, [episodeId], {});
    await fixture.runner.whenIdle();

    let view = fixture.storyboards.getView(fixture.work.id, episodeId);
    assert.equal(view.run.display, 'failed');
    assert.match(view.run.errorMessage ?? '', /不存在的角色“路人”/);
    assert.equal(view.run.hasRawOutput, true);
    assert.deepEqual(view.shots, []);
    assert.equal(view.actions.canEdit, false);

    await fixture.stages.retry(run.id);
    await fixture.runner.whenIdle();
    view = fixture.storyboards.getView(fixture.work.id, episodeId);
    assert.equal(view.run.display, 'pending');
    assert.equal(view.shots.length, 2);
  } finally {
    fixture.database.close();
  }
});

test('取消与删除：删除作品前取消各集正在进行的生成；没有可用模型时启动失败且不留记录', async () => {
  const hang: Responder = (request) =>
    request.user.includes('# 任务：生成分镜脚本') ? new Promise(() => undefined) : standardResponder(request);
  const fixture = await createFixture('多集短片', true, hang);
  try {
    const episodeIds = fixture.storyboards.listEpisodeStatuses(fixture.work.id).map((status) => status.episodeId);
    const runs = await fixture.storyboards.start(fixture.work.id, episodeIds, {});
    assert.equal(runs.length, 2);
    fixture.stages.cancelRunningForWork(fixture.work.id);
    await fixture.runner.whenIdle();
    assert.deepEqual(fixture.storyboards.listEpisodeStatuses(fixture.work.id).map((status) => status.display), ['canceled', 'canceled']);

    fixture.text.unavailable = true;
    await assert.rejects(fixture.storyboards.start(fixture.work.id, episodeIds, {}), TextGenerationError);
    assert.deepEqual(fixture.storyboards.listEpisodeStatuses(fixture.work.id).map((status) => status.version), [1, 1]);
  } finally {
    fixture.database.close();
  }
});
