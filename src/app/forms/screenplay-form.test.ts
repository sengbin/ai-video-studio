// ------------------------------------------------------------------------
// 名称：screenplay-form.test.ts
// 说明：剧本表单（F4）的自动化测试：字段随作品形态变化、创意未确认时不能打开、提交启动生成、重新生成的初始值、输入不合法、选择作品。
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
import { SCREENPLAY_FORM_NAMES, createScreenplayFormCatalog } from './screenplay-form';

const CREATIVE_PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };

/** 创建夹具，并按需创建一个创意已确认的作品。 */
async function createFixture(kind: '单个短视频' | '多集短片', approveCreative = true) {
  const fixture = createServiceFixture();
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind }, 'text'));
  const creative = await fixture.stages.startCreative(work.id, CREATIVE_PARAMS);
  await fixture.runner.whenIdle();
  if (approveCreative) {
    fixture.stages.approve(creative.id);
  }
  const started: number[] = [];
  const picked: number[] = [];
  const catalog = createScreenplayFormCatalog({
    projects: fixture.projects,
    works: fixture.works,
    screenplays: fixture.screenplays,
    onStarted: (workId) => started.push(workId),
    onPicked: (workId) => picked.push(workId)
  });
  const open = (params: unknown, name: string = SCREENPLAY_FORM_NAMES.start): FormDefinition => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { ...fixture, work, started, picked, open };
}

test('字段：多集作品有集数上限，单个短视频没有；新建时没有初始值', async () => {
  const series = await createFixture('多集短片');
  const single = await createFixture('单个短视频');
  try {
    const seriesForm = series.open({ workId: series.work.id });
    assert.deepEqual(seriesForm.schema.fields.map((field) => field.key), ['maxEpisodeDurationSeconds', 'maxEpisodes', 'extra']);
    assert.equal(seriesForm.schema.title, '生成剧本：作品甲');
    assert.deepEqual(seriesForm.initialValues, {});
    assert.deepEqual(single.open({ workId: single.work.id }).schema.fields.map((field) => field.key), ['maxEpisodeDurationSeconds', 'extra']);
  } finally {
    series.database.close();
    single.database.close();
  }
});

test('打开：创意未确认或作品不存在时报错', async () => {
  const { database, open, work } = await createFixture('单个短视频', false);
  try {
    assert.throws(() => open({ workId: work.id }), (error) => error instanceof ValidationError && /请先确认创意/.test(error.message));
    assert.throws(() => open({ workId: 999 }), NotFoundError);
    assert.throws(() => open({}), ValidationError);
  } finally {
    database.close();
  }
});

test('提交：启动生成并通知页面；输入不合法时返回字段错误且不创建记录；重新生成时带出上次的参数', async () => {
  const { database, open, work, started, screenplays, runner } = await createFixture('多集短片');
  try {
    const form = open({ workId: work.id });
    await assert.rejects(
      Promise.resolve(form.submit({ maxEpisodeDurationSeconds: '', maxEpisodes: '0' })),
      (error) => error instanceof ValidationError && error.fieldErrors.maxEpisodeDurationSeconds !== undefined && error.fieldErrors.maxEpisodes !== undefined
    );
    assert.deepEqual(started, []);

    await form.submit({ maxEpisodeDurationSeconds: '90', maxEpisodes: '3', extra: '悬疑' });
    await runner.whenIdle();
    assert.deepEqual(started, [work.id]);
    assert.equal(screenplays.getView(work.id).run.display, 'pending');

    assert.deepEqual(open({ workId: work.id }).initialValues, { maxEpisodeDurationSeconds: '90', maxEpisodes: '3', extra: '悬疑' });
  } finally {
    database.close();
  }
});

test('选择作品：只列创意已确认的作品，标签为“项目 › 作品”；只有一个时预选；提交后通知所选作品', async () => {
  const { database, open, work, picked, projects, works } = await createFixture('单个短视频');
  try {
    // 另一个项目里创意未确认的作品不会出现。
    const other = projects.createProject({ name: '项目乙' });
    works.createWork(other.id, normalizeWorkCreation({ workName: '未确认作品', kind: '单个短视频' }, 'text'));

    const form = open({}, SCREENPLAY_FORM_NAMES.pick);
    const field = form.schema.fields[0];
    assert.deepEqual(field.options, ['项目甲 › 作品甲']);
    assert.deepEqual(form.initialValues, { work: '项目甲 › 作品甲' });

    assert.throws(() => form.submit({ work: '' }), (error) => error instanceof ValidationError && error.fieldErrors.work !== undefined);
    assert.deepEqual(picked, []);
    await form.submit({ work: '项目甲 › 作品甲' });
    assert.deepEqual(picked, [work.id]);

    // 限定项目：该项目下没有可选作品时不能打开。
    assert.throws(() => open({ projectId: other.id }, SCREENPLAY_FORM_NAMES.pick), (error) => error instanceof ValidationError && /没有可生成剧本的作品/.test(error.message));
  } finally {
    database.close();
  }
});
