// ------------------------------------------------------------------------
// 名称：stage-service.test.ts
// 说明：作品服务与阶段服务的自动化测试：创建作品、启动创意生成、确认采用、编辑保存、重试、取消与变化通知。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库、真实的执行器与创意工作流，以及脚本化的假文本生成端口。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictError, NotFoundError, TextGenerationError, ValidationError } from '../../domain/errors';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { Responder, standardResponder } from '../stages/testing/scripted-text';
import { createServiceFixture } from './testing/service-fixture';
import { DUPLICATE_WORK_NAME_MESSAGE } from './work-service';

const PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };

/** 创建夹具，并在项目内创建一个文字灵感作品。 */
function createFixture(responder: Responder = standardResponder) {
  const fixture = createServiceFixture(responder);
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  return { ...fixture, work };
}
test('创建作品：单个短视频同时创建第 1 集，名称在项目内唯一，变化后通知项目标识', () => {
  const { database, works, project, work } = createFixture();
  try {
    const notified: number[] = [];
    works.onDidChangeWorks((projectId) => notified.push(projectId));

    const episodes = database.prepare('SELECT seq, title FROM episodes WHERE work_id = ?').all(work.id);
    assert.deepEqual(episodes.map((row) => [row.seq, row.title]), [[1, '作品甲']]);

    assert.throws(
      () => works.createWork(project.id, normalizeWorkCreation({ workName: '作品甲', kind: '多集短片' }, 'text')),
      (error) => error instanceof ConflictError && error.message === DUPLICATE_WORK_NAME_MESSAGE
    );
    const series = works.createWork(project.id, normalizeWorkCreation({ workName: '作品乙', kind: '多集短片' }, 'text'));
    assert.deepEqual(notified, [project.id]);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes WHERE work_id = ?').get(series.id)?.n, 0);
    assert.equal(works.isWorkNameAvailable(project.id, ' 作品乙 '), false);
    assert.equal(works.isWorkNameAvailable(project.id, '作品丙'), true);
  } finally {
    database.close();
  }
});

test('创建作品：图片素材按上传顺序保存，删除作品级联清除', () => {
  const { database, works, project } = createFixture();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const files = JSON.stringify(['a.png', 'b.png'].map((name) => ({ name, data: png.toString('base64') })));
    const work = works.createWork(project.id, normalizeWorkCreation({ workName: '图片作品', kind: '单个短视频', images: files }, 'image'));
    const sources = database.prepare('SELECT file_name, mime, sort_order FROM work_sources WHERE work_id = ? ORDER BY sort_order').all(work.id);
    assert.deepEqual(sources.map((row) => [row.file_name, row.mime, row.sort_order]), [
      ['a.png', 'image/png', 0],
      ['b.png', 'image/png', 1]
    ]);

    works.deleteWork(work.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM work_sources').get()?.n, 0);
    assert.throws(() => works.deleteWork(work.id), NotFoundError);
  } finally {
    database.close();
  }
});

test('创意生成到确认：生成后待确认，编辑保存修订号加 1，确认后成为当前版本，再编辑回到待确认', async () => {
  const { database, stages, runner, works, project, work, changed } = createFixture();
  try {
    assert.equal(works.listWorks(project.id)[0].creative.display, 'none');

    const run = await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();

    let view = stages.getCreativeView(work.id);
    assert.equal(view.run.id, run.id);
    assert.equal(view.run.display, 'pending');
    assert.deepEqual(view.chapters.map((chapter) => [chapter.seq, chapter.title, chapter.wordCount, chapter.wordHint]), [
      [1, '第1章', 120, null],
      [2, '第2章', 120, null],
      [3, '第3章', 120, null]
    ]);
    assert.equal(view.totalWords, 360);
    assert.deepEqual(view.actions, { canApprove: true, canCancel: false, canRetry: false, canEdit: true, editNeedsConfirm: false });
    assert.ok(changed.length > 0 && changed.every((change) => change.workId === work.id && change.stage === 'creative'));

    // 编辑：字数不在范围内只给提示，不阻止保存。
    stages.saveChapter(run.id, { seq: 2, title: '转折（改）', content: '短' });
    view = stages.getCreativeView(work.id);
    assert.equal(view.chapters[1].title, '转折（改）');
    assert.equal(view.chapters[1].wordHint, 'short');
    assert.equal(view.run.display, 'pending');

    stages.approve(run.id);
    view = stages.getCreativeView(work.id);
    assert.equal(view.run.display, 'approved');
    assert.equal(view.run.isCurrent, true);
    assert.equal(view.actions.canApprove, false);
    assert.equal(view.actions.editNeedsConfirm, true);
    assert.equal(works.listWorks(project.id)[0].creative.display, 'approved');

    stages.saveChapter(run.id, { seq: 1, title: '开端', content: '新的正文' });
    assert.equal(stages.getCreativeView(work.id).run.display, 'pending');
    assert.equal(stages.getCreativeView(work.id).run.isCurrent, false);
  } finally {
    database.close();
  }
});

test('编辑校验：标题与正文必填，章节必须存在，只能编辑最新版本，重复确认被拒绝', async () => {
  const { database, stages, runner, work } = createFixture();
  try {
    const first = await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();

    assert.throws(() => stages.saveChapter(first.id, { seq: 1, title: '', content: '正文' }), ValidationError);
    assert.throws(() => stages.saveChapter(first.id, { seq: 1, title: '标题', content: '  ' }), ValidationError);
    assert.throws(() => stages.saveChapter(first.id, { seq: 9, title: '标题', content: '正文' }), NotFoundError);

    stages.approve(first.id);
    assert.throws(() => stages.approve(first.id), ValidationError);

    const second = await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();
    assert.throws(
      () => stages.saveChapter(first.id, { seq: 1, title: '标题', content: '正文' }),
      (error) => error instanceof ValidationError && /最新版本/.test(error.message)
    );
    stages.approve(second.id);

    const view = stages.getCreativeView(work.id, first.id);
    assert.deepEqual(view.versions.map((item) => [item.version, item.display, item.isCurrent]), [
      [2, 'approved', true],
      [1, 'history', false]
    ]);
    assert.equal(view.actions.canEdit, false);
    assert.throws(() => stages.getCreativeView(work.id, 999), NotFoundError);
  } finally {
    database.close();
  }
});

test('失败后重试：从已保存的章节继续，原始输出可查看', async () => {
  let broken = true;
  const { database, stages, runner, work } = createFixture((request) =>
    broken && request.user.includes('# 任务：撰写第 3 章') ? { title: '缺少正文' } : standardResponder(request)
  );
  try {
    const run = await stages.startCreative(work.id, PARAMS);
    await runner.whenIdle();

    let view = stages.getCreativeView(work.id);
    assert.equal(view.run.display, 'failed');
    assert.equal(view.chapters.length, 2);
    assert.equal(view.run.hasRawOutput, true);
    assert.match(stages.getRawOutput(run.id), /缺少正文/);
    assert.equal(view.actions.canRetry, true);
    assert.equal(view.actions.canEdit, false);
    assert.throws(() => stages.approve(run.id), ValidationError);

    broken = false;
    await stages.retry(run.id);
    await runner.whenIdle();
    view = stages.getCreativeView(work.id);
    assert.equal(view.run.display, 'pending');
    assert.equal(view.chapters.length, 3);
    assert.equal(view.versions.length, 1);
  } finally {
    database.close();
  }
});

test('取消：生成中可取消，取消后可重试；没有生成时取消被拒绝', async () => {
  const { database, stages, runner, work, text } = createFixture(() => new Promise<string>(() => undefined));
  try {
    const run = await stages.startCreative(work.id, PARAMS);
    assert.equal(stages.getCreativeView(work.id).actions.canCancel, true);
    await assert.rejects(() => stages.startCreative(work.id, PARAMS), ValidationError);

    stages.cancel(run.id);
    await runner.whenIdle();
    assert.equal(stages.getCreativeView(work.id).run.display, 'canceled');
    assert.throws(() => stages.cancel(run.id), ValidationError);
    assert.ok(text.requests.length > 0);
  } finally {
    database.close();
  }
});

test('模型不可用时启动失败，不留下阶段记录；参数不合法时返回字段错误', async () => {
  const { database, stages, text, runs, work } = createFixture();
  try {
    text.unavailable = true;
    await assert.rejects(() => stages.startCreative(work.id, PARAMS), TextGenerationError);
    assert.equal(runs.listVersions({ workId: work.id, stage: 'creative', episodeId: null }).length, 0);

    text.unavailable = false;
    await assert.rejects(
      () => stages.startCreative(work.id, { ...PARAMS, chapterMaxWords: 50 }),
      (error) => error instanceof ValidationError && 'chapterMaxWords' in error.fieldErrors
    );
    await assert.rejects(() => stages.startCreative(999, PARAMS), NotFoundError);
  } finally {
    database.close();
  }
});

test('上次使用的参数：重新生成表单以它为初始值', async () => {
  const { database, stages, runner, work } = createFixture();
  try {
    assert.equal(stages.getLastCreativeParams(work.id), undefined);
    await stages.startCreative(work.id, { ...PARAMS, genre: '悬疑', idea: '灯塔' });
    await runner.whenIdle();
    const params = stages.getLastCreativeParams(work.id);
    assert.equal(params?.genre, '悬疑');
    assert.equal(params?.idea, '灯塔');
    assert.equal(params?.maxChapters, 3);
  } finally {
    database.close();
  }
});

test('删除前取消：作品有正在生成的记录时先取消', async () => {
  const { database, stages, runner, work, runs } = createFixture(() => new Promise<string>(() => undefined));
  try {
    const run = await stages.startCreative(work.id, PARAMS);
    stages.cancelRunningForWork(work.id);
    await runner.whenIdle();
    assert.equal(runs.findById(run.id)?.status, 'canceled');
    stages.cancelRunningForWork(work.id);
  } finally {
    database.close();
  }
});
