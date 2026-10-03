// ------------------------------------------------------------------------
// 名称：screenplay-service.test.ts
// 说明：剧本阶段应用服务的自动化测试：生成、视图、编辑保存、确认时合并集和实体（含新版本里已不存在的旧集的删除与拒绝）、合并后的编辑、调整集的顺序、重新抽取、上游变更与失败后继续。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、真实的执行器与两个阶段的工作流，以及脚本化的假文本生成端口。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { REMOVED_EPISODES_BLOCKED_MESSAGE } from '../../infra/database/sqlite-screenplay-repository';
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

/** 再生成一个剧本版本，并把它的抽取结果改成只剩第 1 集（用于模拟新版本里旧集已不存在）。 */
async function startKeepingOnlyFirstEpisode(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const run = await generate(fixture);
  const structure = {
    episodes: [{ seq: 1, title: '第一集', synopsis: '新梗概', screenplayText: '新正文', targetDurationSeconds: 30 }],
    entities: [{ kind: 'character', name: '守夜人', aliases: [], description: '新设定', attributes: {}, isActive: true }]
  };
  fixture.database.prepare('UPDATE screenplays SET structure_json = ? WHERE run_id = ?').run(JSON.stringify(structure), run.id);
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

test('确认采用：新版本里已不存在的旧集没有下游数据时随合并删除，确认前视图列出将被移除的集', async () => {
  const fixture = await createFixture('多集短片');
  const { database, screenplays, stages, work } = fixture;
  try {
    stages.approve((await generate(fixture)).id);
    const [first] = screenplays.getView(work.id).episodes;
    const second = await startKeepingOnlyFirstEpisode(fixture);

    const preview = screenplays.getView(work.id);
    assert.deepEqual([preview.removedEpisodes, preview.blockedEpisodes], [[2], []]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes WHERE work_id = ?').get(work.id)?.n, 2, '确认前不改动');

    stages.approve(second.id);
    const rows = database.prepare('SELECT id, seq, synopsis FROM episodes WHERE work_id = ? ORDER BY seq').all(work.id);
    assert.deepEqual(rows.map((row) => [row.id, row.seq, row.synopsis]), [[first.ref, 1, '新梗概']]);
    const merged = screenplays.getView(work.id);
    assert.deepEqual([merged.merged, merged.episodes.length, merged.removedEpisodes, merged.blockedEpisodes], [true, 1, [], []]);
  } finally {
    database.close();
  }
});

test('确认采用：新版本里已不存在的旧集已有分镜脚本时拒绝合并并整体回滚；在新版本中保留这些集后可以确认', async () => {
  const fixture = await createFixture('多集短片');
  const { database, screenplays, storyboards, stages, runs, work } = fixture;
  try {
    stages.approve((await generate(fixture)).id);
    const [first, second] = screenplays.getView(work.id).episodes;
    await storyboards.start(work.id, [second.ref], {});
    await fixture.runner.whenIdle();
    const next = await startKeepingOnlyFirstEpisode(fixture);

    const preview = screenplays.getView(work.id);
    assert.deepEqual([preview.removedEpisodes, preview.blockedEpisodes, preview.downstreamEpisodes], [[], [2], [2]]);
    assert.throws(
      () => stages.approve(next.id),
      (error) => error instanceof ValidationError && error.message === REMOVED_EPISODES_BLOCKED_MESSAGE([2])
    );
    // 合并整体回滚：集、实体、新版本的确认状态都没有变化。
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes WHERE work_id = ?').get(work.id)?.n, 2);
    assert.equal(database.prepare("SELECT is_active AS active FROM script_entities WHERE name = '灯塔'").get()?.active, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM stage_runs WHERE episode_id = ?').get(second.ref)?.n, 1);
    assert.deepEqual([runs.findById(next.id)!.isCurrent, runs.findById(next.id)!.appliedAt], [false, null]);

    // 在新版本中补回这一集（序号 2）后可以确认，这一集和它的分镜脚本保留。
    screenplays.addEpisode(next.id, { title: '第二集', synopsis: '', screenplayText: '正文', targetDurationSeconds: '' });
    assert.deepEqual([screenplays.getView(work.id).removedEpisodes, screenplays.getView(work.id).blockedEpisodes], [[], []]);
    stages.approve(next.id);
    const rows = database.prepare('SELECT id, seq FROM episodes WHERE work_id = ? ORDER BY seq').all(work.id);
    assert.deepEqual(rows.map((row) => [row.id, row.seq]), [[first.ref, 1], [second.ref, 2]]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM stage_runs WHERE episode_id = ?').get(second.ref)?.n, 1);
  } finally {
    database.close();
  }
});

test('确认采用：新版本里已不存在的旧集已有集的生成参数时同样拒绝合并', async () => {
  const fixture = await createFixture('多集短片');
  const { database, screenplays, stages, work } = fixture;
  try {
    stages.approve((await generate(fixture)).id);
    const [, second] = screenplays.getView(work.id).episodes;
    database.prepare("INSERT INTO generation_profiles (scope, episode_id, updated_at) VALUES ('episode', ?, '2026-10-03T00:00:00.000Z')").run(second.ref);
    const next = await startKeepingOnlyFirstEpisode(fixture);

    assert.deepEqual(screenplays.getView(work.id).blockedEpisodes, [2]);
    assert.throws(() => stages.approve(next.id), ValidationError);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes WHERE work_id = ?').get(work.id)?.n, 2);
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

test('新增与删除（合并前）：改的是抽取结果，序号重排，修订号加 1；单个短视频不能增删集，至少保留 1 集', async () => {
  const fixture = await createFixture('多集短片', twoCharacters);
  const { database, screenplays, runs, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    const revision = runs.findById(run.id)!.revision;

    const episodeRef = screenplays.addEpisode(run.id, { title: '第三集', synopsis: '新梗概', screenplayText: '第三集正文', targetDurationSeconds: '20' });
    assert.equal(episodeRef, 2);
    let view = screenplays.getView(work.id);
    assert.deepEqual(view.episodes.map((episode) => [episode.ref, episode.seq, episode.title]), [[0, 1, '第一集'], [1, 2, '第二集'], [2, 3, '第三集']]);
    assert.equal(view.episodes[2].targetDurationSeconds, 20);

    screenplays.deleteEpisode(run.id, { ref: 0 });
    view = screenplays.getView(work.id);
    assert.deepEqual(view.episodes.map((episode) => [episode.ref, episode.seq, episode.title]), [[0, 1, '第二集'], [1, 2, '第三集']]);

    assert.throws(() => screenplays.addEpisode(run.id, { title: '' }), (error) => error instanceof ValidationError && error.fieldErrors.title !== undefined);
    assert.throws(() => screenplays.deleteEpisode(run.id, { ref: 9 }), NotFoundError);
    screenplays.deleteEpisode(run.id, { ref: 0 });
    assert.throws(() => screenplays.deleteEpisode(run.id, { ref: 0 }), /至少保留 1 集/);

    const entityRef = screenplays.addEntity(run.id, { kind: 'prop', name: '钥匙', aliases: '铜钥匙', description: '灯塔的钥匙', attributes: { usage: '开门' }, isActive: true });
    assert.equal(entityRef, 3);
    const added = screenplays.getView(work.id).entities[3];
    assert.deepEqual([added.kind, added.name, added.aliases, added.attributes], ['prop', '钥匙', ['铜钥匙'], { usage: '开门' }]);
    assert.throws(() => screenplays.addEntity(run.id, { kind: 'prop', name: '钥匙' }), (error) => error instanceof ValidationError && error.fieldErrors.name !== undefined);
    assert.throws(() => screenplays.addEntity(run.id, { kind: 'bogus', name: 'x' }), (error) => error instanceof ValidationError && error.fieldErrors.kind !== undefined);
    screenplays.addEntity(run.id, { kind: 'scene', name: '钥匙' });

    screenplays.deleteEntity(run.id, { ref: 0 });
    assert.deepEqual(screenplays.getView(work.id).entities.map((entity) => entity.name), ['灯塔', '学徒', '钥匙', '钥匙']);
    assert.throws(() => screenplays.deleteEntity(run.id, { ref: 9 }), NotFoundError);
    assert.equal(runs.findById(run.id)!.revision, revision + 6, '成功的编辑各加 1，被拒绝的不改变修订号');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM script_entities').get()?.n, 0, '确认前不影响作品的实体');
  } finally {
    database.close();
  }

  const single = await createFixture('单个短视频');
  try {
    const run = await generate(single);
    assert.throws(() => single.screenplays.addEpisode(run.id, { title: '另一集' }), /单个短视频只有 1 集/);
    assert.throws(() => single.screenplays.deleteEpisode(run.id, { ref: 0 }), /单个短视频只有 1 集/);
    single.screenplays.addEntity(run.id, { kind: 'prop', name: '钥匙' });
    assert.equal(single.screenplays.getView(single.work.id).entities.length, 3);
  } finally {
    single.database.close();
  }
});

test('调整集的顺序（合并前）：互换抽取结果中的位置并重排序号，返回新位置；边界、单个短视频、不存在的集被拒绝', async () => {
  const fixture = await createFixture('多集短片', twoCharacters);
  const { database, screenplays, runs, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    const revision = runs.findById(run.id)!.revision;

    assert.equal(screenplays.moveEpisode(run.id, { ref: 0, direction: 'down' }), 1);
    assert.deepEqual(screenplays.getView(work.id).episodes.map((episode) => [episode.ref, episode.seq, episode.title]), [[0, 1, '第二集'], [1, 2, '第一集']]);
    assert.equal(screenplays.moveEpisode(run.id, { ref: 1, direction: 'up' }), 0);
    assert.deepEqual(screenplays.getView(work.id).episodes.map((episode) => episode.title), ['第一集', '第二集']);
    assert.equal(runs.findById(run.id)!.revision, revision + 2);

    assert.throws(() => screenplays.moveEpisode(run.id, { ref: 0, direction: 'up' }), /已经是第一集/);
    assert.throws(() => screenplays.moveEpisode(run.id, { ref: 1, direction: 'down' }), /已经是最后一集/);
    assert.throws(() => screenplays.moveEpisode(run.id, { ref: 0, direction: 'left' }), ValidationError);
    assert.throws(() => screenplays.moveEpisode(run.id, { ref: 9, direction: 'up' }), NotFoundError);
    assert.equal(runs.findById(run.id)!.revision, revision + 2, '被拒绝的操作不改变修订号');
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes').get()?.n, 0, '确认前不影响作品的集');
  } finally {
    database.close();
  }

  const single = await createFixture('单个短视频');
  try {
    const run = await generate(single);
    assert.throws(() => single.screenplays.moveEpisode(run.id, { ref: 0, direction: 'down' }), /单个短视频只有 1 集/);
  } finally {
    single.database.close();
  }
});

test('调整集的顺序（合并后）：只互换作品中两集的序号，集的标识和分镜脚本跟着集走；版本回到待确认', async () => {
  const fixture = await createFixture('多集短片', twoCharacters);
  const { database, screenplays, storyboards, stages, runs, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    stages.approve(run.id);
    const [first, second] = screenplays.getView(work.id).episodes;
    await storyboards.start(work.id, [first.ref], {});
    await fixture.runner.whenIdle();

    assert.equal(screenplays.moveEpisode(run.id, { ref: first.ref, direction: 'down' }), first.ref, '合并后定位值是集标识，不变');
    const rows = database.prepare('SELECT id, seq, title FROM episodes WHERE work_id = ? ORDER BY seq').all(work.id);
    assert.deepEqual(rows.map((row) => [row.id, row.seq, row.title]), [[second.ref, 1, '第二集'], [first.ref, 2, '第一集']]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM stage_runs WHERE episode_id = ?').get(first.ref)?.n, 1, '分镜脚本仍属于原来的集');
    assert.equal(runs.findById(run.id)!.reviewStatus, 'pending');

    assert.throws(() => screenplays.moveEpisode(run.id, { ref: first.ref, direction: 'down' }), /已经是最后一集/);
    assert.throws(() => screenplays.moveEpisode(run.id, { ref: 9999, direction: 'up' }), NotFoundError);
  } finally {
    database.close();
  }
});

test('新增与删除（合并后）：直接改作品的集和实体，序号重排；删集连同分镜脚本，被引用的实体不能删', async () => {
  const fixture = await createFixture('多集短片', twoCharacters);
  const { database, screenplays, storyboards, stages, runs, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    stages.approve(run.id);
    const [first, second] = screenplays.getView(work.id).episodes;
    await storyboards.start(work.id, [first.ref, second.ref], {});
    await fixture.runner.whenIdle();

    const ref = screenplays.addEpisode(run.id, { title: '第三集', synopsis: '', screenplayText: '正文', targetDurationSeconds: '' });
    assert.equal(database.prepare('SELECT seq FROM episodes WHERE id = ?').get(ref)?.seq, 3);
    assert.equal(runs.findById(run.id)!.reviewStatus, 'pending');

    // 第 1 集已有分镜脚本：删除后序号前移，它的分镜脚本记录一并清除。
    screenplays.deleteEpisode(run.id, { ref: first.ref });
    const rows = database.prepare('SELECT id, seq FROM episodes WHERE work_id = ? ORDER BY seq').all(work.id);
    assert.deepEqual(rows.map((row) => [row.id, row.seq]), [[second.ref, 1], [ref, 2]]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM stage_runs WHERE episode_id = ?').get(first.ref)?.n, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM stage_runs WHERE episode_id = ?').get(second.ref)?.n, 1);
    assert.throws(() => screenplays.deleteEpisode(run.id, { ref: first.ref }), NotFoundError);

    // 实体：被镜头引用的“守夜人”不能删；没被引用的“学徒”和新增的实体可以删。
    const entities = screenplays.getView(work.id).entities;
    const guard = entities.find((entity) => entity.name === '守夜人')!;
    const apprentice = entities.find((entity) => entity.name === '学徒')!;
    const revision = runs.findById(run.id)!.revision;
    assert.throws(() => screenplays.deleteEntity(run.id, { ref: guard.ref }), /已被 \d+ 处引用/);
    assert.equal(runs.findById(run.id)!.revision, revision);
    screenplays.deleteEntity(run.id, { ref: apprentice.ref });
    const keyRef = screenplays.addEntity(run.id, { kind: 'prop', name: '钥匙' });
    assert.equal(database.prepare('SELECT kind FROM script_entities WHERE id = ?').get(keyRef)?.kind, 'prop');
    assert.throws(() => screenplays.addEntity(run.id, { kind: 'prop', name: '钥匙' }), ConflictError);
    screenplays.deleteEntity(run.id, { ref: keyRef });
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM script_entities WHERE name = ?').get('学徒')?.n, 0);

    stages.approve(run.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes WHERE work_id = ?').get(work.id)?.n, 2, '再次确认不会把已删除的集合并回来');
  } finally {
    database.close();
  }
});

test('新增与删除（合并后）：这一集正在生成分镜脚本时不能删除', async () => {
  const fixture = await createFixture('多集短片');
  const { database, screenplays, storyboards, stages, work } = fixture;
  try {
    const run = await screenplays.start(work.id, PARAMS);
    await fixture.runner.whenIdle();
    stages.approve(run.id);
    const [first] = screenplays.getView(work.id).episodes;
    await storyboards.start(work.id, [first.ref], {});
    assert.throws(() => screenplays.deleteEpisode(run.id, { ref: first.ref }), /正在生成分镜脚本/);
    await fixture.runner.whenIdle();
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes WHERE work_id = ?').get(work.id)?.n, 2);
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
