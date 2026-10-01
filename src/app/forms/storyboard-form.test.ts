// ------------------------------------------------------------------------
// 名称：storyboard-form.test.ts
// 说明：分镜脚本表单（F5）的自动化测试：多集可选集、单集与指定集不显示选择、剧本未确认时不能打开、提交启动生成、重新生成的初始值、输入不合法、选择作品。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、真实的执行器与脚本化的假文本生成端口。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, ValidationError } from '../../domain/errors';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { createServiceFixture } from '../services/testing/service-fixture';
import { FormDefinition } from './form-definition';
import { STORYBOARD_FORM_NAMES, createStoryboardFormCatalog } from './storyboard-form';

const CREATIVE_PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };
const SCREENPLAY_PARAMS = { maxEpisodeDurationSeconds: '60', maxEpisodes: '3' };

/** 创建夹具与作品，创意已确认；approveScreenplay 为 true 时剧本也已确认。 */
async function createFixture(kind: '单个短视频' | '多集短片', approveScreenplay = true) {
  const fixture = createServiceFixture();
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind }, 'text'));
  const creative = await fixture.stages.startCreative(work.id, CREATIVE_PARAMS);
  await fixture.runner.whenIdle();
  fixture.stages.approve(creative.id);
  const screenplay = await fixture.screenplays.start(work.id, SCREENPLAY_PARAMS);
  await fixture.runner.whenIdle();
  if (approveScreenplay) {
    fixture.stages.approve(screenplay.id);
  }
  const started: Array<[number, number]> = [];
  const picked: number[] = [];
  const catalog = createStoryboardFormCatalog({
    projects: fixture.projects,
    works: fixture.works,
    storyboards: fixture.storyboards,
    onStarted: (workId, episodeId) => started.push([workId, episodeId]),
    onPicked: (workId) => picked.push(workId)
  });
  const open = (params: unknown, name: string = STORYBOARD_FORM_NAMES.start): FormDefinition => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { ...fixture, work, started, picked, open };
}

test('字段：多集作品可选集，单个短视频或指定了集时不显示选择；新建时带默认值', async () => {
  const series = await createFixture('多集短片');
  const single = await createFixture('单个短视频');
  try {
    const seriesForm = series.open({ workId: series.work.id });
    assert.deepEqual(seriesForm.schema.fields.map((field) => field.key), [
      'episodes',
      'visualStyle',
      'minShotSeconds',
      'maxShotSeconds',
      'maxShots',
      'continuity',
      'audioMode',
      'audioElements',
      'extra'
    ]);
    assert.deepEqual(seriesForm.schema.fields[0].options, ['第 1 集 第一集', '第 2 集 第二集']);
    assert.equal(seriesForm.schema.title, '生成分镜脚本：作品甲');
    assert.equal(seriesForm.initialValues.continuity, '由 AI 判断');
    assert.equal(seriesForm.initialValues.audioMode, '模型原生生成');
    assert.deepEqual(JSON.parse(seriesForm.initialValues.episodes), ['第 1 集 第一集', '第 2 集 第二集']);

    const episodeId = series.storyboards.listEpisodeStatuses(series.work.id)[1].episodeId;
    const oneEpisode = series.open({ workId: series.work.id, episodeId });
    assert.ok(!oneEpisode.schema.fields.some((field) => field.key === 'episodes'));
    assert.equal(oneEpisode.schema.title, '生成分镜脚本：作品甲 › 第 2 集 第二集');

    assert.ok(!single.open({ workId: single.work.id }).schema.fields.some((field) => field.key === 'episodes'));
  } finally {
    series.database.close();
    single.database.close();
  }
});

test('打开：剧本未确认、作品或集不存在时报错', async () => {
  const { database, open, work } = await createFixture('单个短视频', false);
  try {
    assert.throws(() => open({ workId: work.id }), (error) => error instanceof ValidationError && /请先确认剧本/.test(error.message));
    assert.throws(() => open({ workId: 999 }), NotFoundError);
    assert.throws(() => open({}), ValidationError);
  } finally {
    database.close();
  }

  const approved = await createFixture('单个短视频');
  try {
    assert.throws(() => approved.open({ workId: approved.work.id, episodeId: 9999 }), ValidationError);
  } finally {
    approved.database.close();
  }
});

test('提交：为所选集各启动一份并通知页面；至少选一集；输入不合法时返回字段错误；重新生成时带出上次的参数', async () => {
  const { database, open, work, started, storyboards, runner } = await createFixture('多集短片');
  try {
    const form = open({ workId: work.id });
    await assert.rejects(
      Promise.resolve(form.submit({ ...form.initialValues, episodes: '[]' })),
      (error) => error instanceof ValidationError && error.fieldErrors.episodes !== undefined
    );
    await assert.rejects(
      Promise.resolve(form.submit({ ...form.initialValues, maxShots: '0', minShotSeconds: 'x' })),
      (error) => error instanceof ValidationError && error.fieldErrors.maxShots !== undefined && error.fieldErrors.minShotSeconds !== undefined
    );
    assert.deepEqual(started, []);

    const second = storyboards.listEpisodeStatuses(work.id)[1];
    await form.submit({
      ...form.initialValues,
      episodes: JSON.stringify(['第 2 集 第二集']),
      visualStyle: '水彩',
      maxShots: '12',
      continuity: '尾帧接首帧',
      audioElements: JSON.stringify(['角色对白', '背景音乐'])
    });
    await runner.whenIdle();
    assert.deepEqual(started, [[work.id, second.episodeId]]);
    assert.deepEqual(storyboards.listEpisodeStatuses(work.id).map((status) => status.display), ['none', 'pending']);

    const again = open({ workId: work.id });
    assert.equal(again.initialValues.visualStyle, '水彩');
    assert.equal(again.initialValues.maxShots, '12');
    assert.equal(again.initialValues.continuity, '尾帧接首帧');
    assert.deepEqual(JSON.parse(again.initialValues.audioElements), ['角色对白', '背景音乐']);
    // 还没有生成过的集默认勾选。
    assert.deepEqual(JSON.parse(again.initialValues.episodes), ['第 1 集 第一集']);
  } finally {
    database.close();
  }
});

test('选择作品：只列剧本已确认的作品，标签为“项目 › 作品”；提交后通知所选作品；没有可选作品时报错', async () => {
  const { database, open, work, picked, projects, works } = await createFixture('单个短视频');
  try {
    const other = projects.createProject({ name: '项目乙' });
    works.createWork(other.id, normalizeWorkCreation({ workName: '未确认作品', kind: '单个短视频' }, 'text'));

    const form = open({}, STORYBOARD_FORM_NAMES.pick);
    assert.deepEqual(form.schema.fields[0].options, ['项目甲 › 作品甲']);
    assert.deepEqual(form.initialValues, { work: '项目甲 › 作品甲' });
    assert.throws(() => form.submit({ work: '' }), ValidationError);
    form.submit({ work: '项目甲 › 作品甲' });
    assert.deepEqual(picked, [work.id]);

    assert.throws(() => open({ projectId: other.id }, STORYBOARD_FORM_NAMES.pick), ValidationError);
  } finally {
    database.close();
  }
});
