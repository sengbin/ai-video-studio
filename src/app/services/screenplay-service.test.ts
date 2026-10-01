// ------------------------------------------------------------------------
// 名称：screenplay-service.test.ts
// 说明：剧本阶段应用服务的自动化测试：生成、视图、编辑保存、确认时合并集和实体、合并后的编辑、重新抽取、上游变更与失败后继续。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、真实的执行器与两个阶段的工作流，以及脚本化的假文本生成端口。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { Responder, standardResponder } from '../stages/testing/scripted-text';
import { createServiceFixture } from './testing/service-fixture';

const CREATIVE_PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };
const PARAMS = { maxEpisodeDurationSeconds: '60', maxEpisodes: '3' };

/** 在标准抽取结果之外多一个同类型（角色）的实体，用于重名场景。 */
const twoCharacters: Responder = (request) => {
  const output = standardResponder(request) as { entities?: unknown[] };
  if (Array.isArray(output.entities)) {
    output.entities.push({ kind: 'character', name: '学徒', description: '新人' });
  }
  return output;
};

/** 创建夹具、一个作品，并生成并确认它的创意。 */
async function createFixture(kind: '单个短视频' | '多集短片' = '单个短视频', responder: Responder = standardResponder) {
  const fixture = createServiceFixture(responder);
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind }, 'text'));
  const creative = await fixture.stages.startCreative(work.id, CREATIVE_PARAMS);
  await fixture.runner.whenIdle();
  fixture.stages.approve(creative.id);
  return { ...fixture, work, creative };
}

/** 生成剧本并等待完成。 */
async function generate(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const run = await fixture.screenplays.start(fixture.work.id, PARAMS);
  await fixture.runner.whenIdle();
  return run;
}

test('生成：创意未确认时拒绝；确认后生成剧本包与抽取结果，待确认，作品的集和实体保持不变', async () => {
  const fixture = createServiceFixture();
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  try {
    assert.throws(() => fixture.screenplays.assertCanStart(work.id), ValidationError);
    await assert.rejects(fixture.screenplays.start(work.id, PARAMS), /请先确认创意/);
  } finally {
    fixture.database.close();
  }

  const { database, screenplays, runner, work: approvedWork, changed } = await createFixture();
  try {
    const run = await screenplays.start(approvedWork.id, PARAMS);
    await runner.whenIdle();

    const view = screenplays.getView(approvedWork.id);
    assert.equal(view.run.id, run.id);
    assert.equal(view.run.display, 'pending');
    assert.deepEqual(view.params, { maxEpisodeDurationSeconds: 60, maxEpisodes: 1, extra: null });
    assert.equal(view.screenplay?.title, '雨夜来客');
    assert.deepEqual(view.episodes.map((episode) => [episode.ref, episode.title]), [[0, '作品甲']]);
    assert.deepEqual(view.entities.map((entity) => [entity.kind, entity.name]), [['character', '守夜人'], ['scene', '灯塔']]);
    assert.equal(view.merged, false);
    assert.equal(view.stale, false);
    assert.deepEqual(view.actions, {
      canApprove: true,
      canCancel: false,
      canRetry: false,
      canEdit: true,
      editNeedsConfirm: false,
      canReextract: true
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM script_entities').get()?.n, 0, '确认前不合并');
    assert.ok(changed.some((change) => change.stage === 'screenplay'));
    assert.equal(screenplays.getLastParams(approvedWork.id)?.maxEpisodeDurationSeconds, 60);
  } finally {
    database.close();
  }
});

test('生成：输入不合法时不创建记录；多集需要集数上限，抽取按集数上限校验', async () => {
  const fixture = await createFixture('多集短片');
  try {
    await assert.rejects(fixture.screenplays.start(fixture.work.id, { maxEpisodeDurationSeconds: '60' }), (error) => {
      return error instanceof ValidationError && error.fieldErrors.maxEpisodes !== undefined;
    });
    assert.equal(fixture.runs.listVersions({ workId: fixture.work.id, stage: 'screenplay', episodeId: null }).length, 0);

    await fixture.screenplays.start(fixture.work.id, { maxEpisodeDurationSeconds: '60', maxEpisodes: '1' });
    await fixture.runner.whenIdle();
    const view = fixture.screenplays.getView(fixture.work.id);
    assert.equal(view.run.display, 'failed', '模型给出 2 集，超过上限 1 集');
    assert.match(view.run.errorMessage ?? '', /超过上限/);
    assert.equal(view.screenplay?.title, '雨夜来客', '正文已保存，重试时跳过');
  } finally {
    fixture.database.close();
  }
});

test('确认采用：多集作品把抽取的集与实体合并到作品，记录合并时间；再次确认不重复合并', async () => {
  const fixture = await createFixture('多集短片');
  const { database, screenplays, stages, runs, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    stages.approve(run.id);

    const episodes = database.prepare('SELECT seq, title, screenplay_text AS text, target_duration_seconds AS seconds FROM episodes WHERE work_id = ? ORDER BY seq').all(work.id);
    assert.deepEqual(episodes.map((row) => [row.seq, row.title, row.text, row.seconds]), [
      [1, '第一集', '第一集正文', 30],
      [2, '第二集', '第二集正文', 30]
    ]);
    const entities = database.prepare('SELECT kind, name, aliases_json AS aliases, attributes_json AS attributes, is_active AS active FROM script_entities ORDER BY id').all();
    assert.deepEqual(entities.map((row) => [row.kind, row.name, row.aliases, row.active]), [
      ['character', '守夜人', '["老陈"]', 1],
      ['scene', '灯塔', '[]', 1]
    ]);
    assert.equal(JSON.parse(entities[0].attributes as string).identity, '守灯塔三十年');
    const approved = runs.findById(run.id)!;
    assert.ok(approved.appliedAt !== null && approved.isCurrent);

    const view = screenplays.getView(work.id);
    assert.equal(view.merged, true);
    assert.deepEqual(view.episodes.map((episode) => episode.seq), [1, 2]);
    assert.equal(view.actions.editNeedsConfirm, true);
    assert.equal(view.actions.canReextract, false);
  } finally {
    database.close();
  }
});

test('确认采用：单个短视频更新已有的第 1 集；重新生成后再确认，实体按（类型，名称）合并，不再出现的停用，集不删除', async () => {
  const fixture = await createFixture();
  const { database, screenplays, stages, work } = fixture;
  try {
    const first = await generate(fixture);
    stages.approve(first.id);
    const episode = database.prepare('SELECT id, title, screenplay_text AS text FROM episodes WHERE work_id = ?').all(work.id);
    assert.equal(episode.length, 1);
    assert.deepEqual([episode[0].title, episode[0].text], ['作品甲', '场景一 灯塔内 夜\n守夜人点亮灯塔。\n老陈：今晚会下雨。']);
    const lighthouseId = database.prepare("SELECT id FROM script_entities WHERE name = '灯塔'").get()!.id as number;

    // 第二版只保留“守夜人”，灯塔不再出现。
    const second = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    database.prepare("UPDATE screenplays SET structure_json = ? WHERE run_id = ?").run(
      JSON.stringify({
        episodes: [{ seq: 1, title: '作品甲', synopsis: '新梗概', screenplayText: '新正文', targetDurationSeconds: null }],
        entities: [{ kind: 'character', name: '守夜人', aliases: [], description: '新设定', attributes: {}, isActive: true }]
      }),
      second.id
    );
    assert.equal(database.prepare('SELECT is_active AS active FROM script_entities WHERE name = ?').get('灯塔')?.active, 1, '确认前不改动');
    stages.approve(second.id);

    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes WHERE work_id = ?').get(work.id)?.n, 1);
    assert.equal(database.prepare('SELECT synopsis FROM episodes WHERE work_id = ?').get(work.id)?.synopsis, '新梗概');
    const lighthouse = database.prepare('SELECT is_active AS active FROM script_entities WHERE id = ?').get(lighthouseId);
    assert.equal(lighthouse?.active, 0);
    assert.equal(database.prepare("SELECT description FROM script_entities WHERE name = '守夜人'").get()?.description, '新设定');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM script_entities').get()?.n, 2);

    // 第一版不再是当前版本，查看它时显示抽取结果的快照，且只读。
    const history = screenplays.getView(work.id, first.id);
    assert.equal(history.run.display, 'history');
    assert.equal(history.merged, false);
    assert.equal(history.actions.canEdit, false);
  } finally {
    database.close();
  }
});

test('编辑（合并前）：正文、集、实体改的是抽取结果，保存后修订号加 1；实体名称在同类型内不能重复', async () => {
  const fixture = await createFixture('多集短片', twoCharacters);
  const { database, screenplays, runs, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    const revision = runs.findById(run.id)!.revision;

    screenplays.saveText(run.id, { fullText: '改过的正文' });
    assert.equal(screenplays.getView(work.id).screenplay?.fullText, '改过的正文');

    screenplays.saveEpisode(run.id, { ref: 1, title: '改名的第二集', synopsis: '新梗概', screenplayText: '新的第二集正文', targetDurationSeconds: '40' });
    const edited = screenplays.getView(work.id).episodes[1];
    assert.deepEqual([edited.title, edited.synopsis, edited.targetDurationSeconds], ['改名的第二集', '新梗概', 40]);

    screenplays.saveEntity(run.id, { ref: 0, name: '老守夜人', aliases: '阿陈，老陈', description: '改过', attributes: { voice: '沙哑' }, isActive: true });
    const entity = screenplays.getView(work.id).entities[0];
    assert.deepEqual([entity.name, entity.aliases, entity.attributes], ['老守夜人', ['阿陈', '老陈'], { voice: '沙哑' }]);
    assert.equal(runs.findById(run.id)!.revision, revision + 3);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM script_entities').get()?.n, 0, '编辑不影响作品的实体');

    // 同类型（角色）下重名被拒绝且不改变修订号；类型不同（场景）的同名允许。
    const before = runs.findById(run.id)!.revision;
    assert.throws(
      () => screenplays.saveEntity(run.id, { ref: 2, name: '老守夜人' }),
      (error) => error instanceof ValidationError && error.fieldErrors.name !== undefined
    );
    assert.equal(runs.findById(run.id)!.revision, before);
    screenplays.saveEntity(run.id, { ref: 1, name: '老守夜人' });
    assert.equal(screenplays.getView(work.id).entities[1].name, '老守夜人');

    assert.throws(() => screenplays.saveEpisode(run.id, { ref: 9, title: 't' }), NotFoundError);
    assert.throws(() => screenplays.saveEpisode(run.id, { ref: -1, title: 't' }), ValidationError);
    assert.throws(() => screenplays.saveText(run.id, { fullText: ' ' }), ValidationError);
  } finally {
    database.close();
  }
});

test('编辑（合并后）：集与实体直接改作品的数据，版本回到待确认；再次确认不重复合并，改动保留', async () => {
  const fixture = await createFixture('多集短片', twoCharacters);
  const { database, screenplays, stages, runs, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    stages.approve(run.id);
    const view = screenplays.getView(work.id);
    const episode = view.episodes[0];
    const [guard, apprentice, scene] = view.entities;
    assert.deepEqual([guard.name, apprentice.name, scene.name], ['守夜人', '学徒', '灯塔']);

    screenplays.saveEpisode(run.id, { ref: episode.ref, title: '直接改的集', synopsis: '', screenplayText: '正文', targetDurationSeconds: '' });
    screenplays.saveEntity(run.id, { ref: scene.ref, name: '新灯塔', description: '', isActive: false });
    assert.equal(database.prepare('SELECT title FROM episodes WHERE id = ?').get(episode.ref)?.title, '直接改的集');
    const row = database.prepare('SELECT name, is_active AS active FROM script_entities WHERE id = ?').get(scene.ref);
    assert.deepEqual([row?.name, row?.active], ['新灯塔', 0]);
    const edited = runs.findById(run.id)!;
    assert.deepEqual([edited.reviewStatus, edited.isCurrent], ['pending', false]);

    // 同类型重名由仓库拒绝，不改变修订号。
    const revision = edited.revision;
    assert.throws(() => screenplays.saveEntity(run.id, { ref: apprentice.ref, name: '守夜人' }), ConflictError);
    assert.equal(runs.findById(run.id)!.revision, revision);

    stages.approve(run.id);
    assert.equal(database.prepare('SELECT title FROM episodes WHERE id = ?').get(episode.ref)?.title, '直接改的集', '再次确认不会用抽取结果覆盖');
    assert.equal(screenplays.getView(work.id).run.display, 'approved');
  } finally {
    database.close();
  }
});

test('重新抽取：清除并按当前正文重新抽取，修订号加 1；合并后不允许；只能对最新版本', async () => {
  const fixture = await createFixture('多集短片');
  const { database, screenplays, stages, runs, runner, text, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await runner.whenIdle();
    screenplays.saveText(run.id, { fullText: '用户改过的正文' });
    const before = runs.findById(run.id)!.revision;
    const requests = text.requests.length;

    await screenplays.reextract(run.id);
    assert.equal(runs.findById(run.id)?.status, 'running');
    assert.equal(screenplays.getView(work.id).episodes.length, 0, '重新抽取期间抽取结果已清除');
    await runner.whenIdle();

    assert.equal(runs.findById(run.id)?.status, 'succeeded');
    assert.equal(runs.findById(run.id)!.revision, before + 1);
    assert.equal(text.requests.length - requests, 1, '只调用一次抽取，不重新生成正文');
    assert.match(text.requests.at(-1)!.user, /用户改过的正文/);
    assert.equal(screenplays.getView(work.id).episodes.length, 2);

    stages.approve(run.id);
    await assert.rejects(screenplays.reextract(run.id), /已经合并/);

    const second = await screenplays.start(work.id, PARAMS);
    await runner.whenIdle();
    await assert.rejects(screenplays.reextract(run.id), /最新版本/);
    assert.ok(second.id > run.id);
  } finally {
    database.close();
  }
});

test('重新抽取失败：保留正文，点重试继续抽取，不重新生成正文', async () => {
  let broken = false;
  const fixture = await createFixture('多集短片', (request) =>
    broken && request.user.includes('# 任务：从剧本中抽取集和实体') ? { episodes: [] } : standardResponder(request)
  );
  const { screenplays, stages, runs, runner, text, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await runner.whenIdle();

    broken = true;
    await screenplays.reextract(run.id);
    await runner.whenIdle();
    assert.equal(runs.findById(run.id)?.status, 'failed');
    assert.ok(screenplays.getView(work.id).run.hasRawOutput);
    assert.equal(screenplays.getView(work.id).screenplay?.title, '雨夜来客');

    broken = false;
    const requests = text.requests.length;
    await stages.retry(run.id);
    await runner.whenIdle();
    assert.equal(runs.findById(run.id)?.status, 'succeeded');
    assert.equal(text.requests.length - requests, 1);
    assert.equal(screenplays.getView(work.id).episodes.length, 2);
  } finally {
    fixture.database.close();
  }
});

test('上游变更：创意被修改后，剧本显示上游已变更；作品列表同步给出剧本状态', async () => {
  const fixture = await createFixture();
  const { database, screenplays, stages, works, work, creative } = fixture;
  try {
    const run = await generate(fixture);
    stages.approve(run.id);
    assert.equal(screenplays.getView(work.id).stale, false);
    const [item] = works.listWorks(work.projectId);
    assert.deepEqual([item.screenplay.display, item.screenplay.stale, item.canStartScreenplay], ['approved', false, true]);

    stages.saveChapter(creative.id, { seq: 1, title: '改过', content: '改过的正文' });
    assert.equal(screenplays.getView(work.id).stale, true);
    const [changed] = works.listWorks(work.projectId);
    assert.deepEqual([changed.screenplay.stale, changed.canStartScreenplay], [true, false], '创意回到待确认，不能再基于它开始新剧本');
  } finally {
    database.close();
  }
});

test('删除作品：先取消正在进行的剧本生成，级联清除剧本包', async () => {
  const fixture = await createFixture();
  const { database, screenplays, stages, works, runner, work } = fixture;
  try {
    const run = await generate(fixture);
    stages.approve(run.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM screenplays').get()?.n, 1);
    stages.cancelRunningForWork(work.id);
    works.deleteWork(work.id);
    await runner.whenIdle();
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM screenplays').get()?.n, 0);
    assert.throws(() => screenplays.getView(work.id), NotFoundError);
  } finally {
    database.close();
  }
});
