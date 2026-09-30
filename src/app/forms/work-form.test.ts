// ------------------------------------------------------------------------
// 名称：work-form.test.ts
// 说明：创意表单（F3）的自动化测试：字段随素材来源变化、提交创建作品并启动生成、失败回滚、重新生成的初始值。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库、真实的执行器与脚本化的假文本生成端口。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, TextGenerationError, ValidationError } from '../../domain/errors';
import { createServiceFixture } from '../services/testing/service-fixture';
import { DUPLICATE_WORK_NAME_MESSAGE } from '../services/work-service';
import { FormDefinition } from './form-definition';
import { WORK_FORM_NAMES, createWorkFormCatalog } from './work-form';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const VALID_VALUES = {
  workName: '雨夜来客',
  kind: '单个短视频',
  idea: '一个关于灯塔的故事',
  chapterMinWords: '100',
  chapterMaxWords: '200',
  maxChapters: '3'
};

/** 提交并等待完成，供 assert.rejects 使用（提交可能同步或异步）。 */
async function submit(form: FormDefinition, values: Record<string, string>): Promise<void> {
  await form.submit(values);
}

function createFixture() {
  const fixture = createServiceFixture();
  const started: number[] = [];
  const catalog = createWorkFormCatalog({
    projects: fixture.projects,
    works: fixture.works,
    stages: fixture.stages,
    onStarted: (workId) => started.push(workId)
  });
  const open = (name: string, params: unknown): FormDefinition => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { ...fixture, started, open };
}
test('新建表单：字段随素材来源变化，标题带素材来源，初始值含默认形态与字数', () => {
  const { database, project, open } = createFixture();
  try {
    const keysOf = (sourceType: string) => open(WORK_FORM_NAMES.create, { projectId: project.id, sourceType }).schema.fields.map((field) => field.key);
    const common = ['genre', 'tone', 'chapterMinWords', 'chapterMaxWords', 'maxChapters'];
    assert.deepEqual(keysOf('text'), ['workName', 'kind', 'idea', ...common, 'extra']);
    assert.deepEqual(keysOf('image'), ['workName', 'kind', 'images', ...common, 'preserve', 'extra']);
    assert.deepEqual(keysOf('novel'), ['workName', 'kind', 'novelFile', ...common, 'preserve', 'adjust', 'extra']);

    const form = open(WORK_FORM_NAMES.create, { projectId: project.id, sourceType: 'image' });
    assert.equal(form.schema.title, '新建作品（灵感图片）');
    assert.equal(form.schema.fields.find((field) => field.key === 'images')?.control, 'file');
    assert.deepEqual(form.initialValues, { kind: '单个短视频', chapterMinWords: '100', chapterMaxWords: '2500', maxChapters: '20' });
  } finally {
    database.close();
  }
});

test('打开参数：项目不存在、素材来源无效时被拒绝', () => {
  const { database, open } = createFixture();
  try {
    assert.throws(() => open(WORK_FORM_NAMES.create, { projectId: 999, sourceType: 'text' }), NotFoundError);
    assert.throws(() => open(WORK_FORM_NAMES.create, { projectId: 1, sourceType: 'video' }), ValidationError);
    assert.throws(() => open(WORK_FORM_NAMES.create, { sourceType: 'text' }), ValidationError);
    assert.throws(() => open(WORK_FORM_NAMES.regenerate, { workId: 999 }), NotFoundError);
  } finally {
    database.close();
  }
});

test('提交：创建作品并启动创意生成，随后通知打开产出页', async () => {
  const { database, works, stages, runner, started, project, open } = createFixture();
  try {
    const form = open(WORK_FORM_NAMES.create, { projectId: project.id, sourceType: 'text' });
    await form.submit(VALID_VALUES);
    await runner.whenIdle();

    const [work] = works.listWorks(project.id);
    assert.equal(work.name, '雨夜来客');
    assert.equal(work.sourceType, 'text');
    assert.deepEqual(started, [work.id]);
    assert.equal(stages.getCreativeView(work.id).chapters.length, 3);
    assert.equal(stages.getLastCreativeParams(work.id)?.idea, '一个关于灯塔的故事');

    // 同名作品：检查与提交都返回重名提示。
    assert.equal(form.checkField?.('workName', '雨夜来客'), DUPLICATE_WORK_NAME_MESSAGE);
    assert.equal(form.checkField?.('workName', '别的名字'), undefined);
    await assert.rejects(() => submit(form, VALID_VALUES), (error) => error instanceof Error && error.message === DUPLICATE_WORK_NAME_MESSAGE);
  } finally {
    database.close();
  }
});

test('提交：图片素材保存到作品，作品名称与生成参数的错误一并返回且不创建作品', async () => {
  const { database, works, runner, project, open } = createFixture();
  try {
    const form = open(WORK_FORM_NAMES.create, { projectId: project.id, sourceType: 'image' });
    const images = JSON.stringify([{ name: 'a.png', data: PNG.toString('base64') }]);
    await form.submit({ ...VALID_VALUES, images });
    await runner.whenIdle();
    const count = database.prepare("SELECT COUNT(*) AS n FROM work_sources WHERE kind = 'image'").get()?.n;
    assert.equal(count, 1);

    await assert.rejects(
      () => submit(form, { ...VALID_VALUES, workName: '', images: '', chapterMaxWords: '10' }),
      (error) =>
        error instanceof ValidationError &&
        ['workName', 'images', 'chapterMaxWords'].every((key) => key in error.fieldErrors)
    );
    assert.equal(works.listWorks(project.id).length, 1);
  } finally {
    database.close();
  }
});

test('提交：没能启动生成时撤销刚创建的作品，修正后可以直接重试', async () => {
  const { database, works, runner, text, started, project, open } = createFixture();
  try {
    const form = open(WORK_FORM_NAMES.create, { projectId: project.id, sourceType: 'text' });
    text.unavailable = true;
    await assert.rejects(() => submit(form, VALID_VALUES), TextGenerationError);
    assert.equal(works.listWorks(project.id).length, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM episodes').get()?.n, 0);
    assert.deepEqual(started, []);

    text.unavailable = false;
    await form.submit(VALID_VALUES);
    await runner.whenIdle();
    assert.equal(works.listWorks(project.id).length, 1);
  } finally {
    database.close();
  }
});

test('重新生成：只有生成参数字段，初始值为上次参数，提交产生新版本', async () => {
  const { database, works, stages, runner, started, project, open } = createFixture();
  try {
    await open(WORK_FORM_NAMES.create, { projectId: project.id, sourceType: 'text' }).submit({ ...VALID_VALUES, genre: '悬疑' });
    await runner.whenIdle();
    const [work] = works.listWorks(project.id);

    const form = open(WORK_FORM_NAMES.regenerate, { workId: work.id });
    assert.equal(form.schema.title, '重新生成创意：雨夜来客');
    assert.equal(form.schema.fields.some((field) => field.key === 'workName'), false);
    assert.equal(form.initialValues.genre, '悬疑');
    assert.equal(form.initialValues.chapterMaxWords, '200');
    assert.equal(form.initialValues.idea, '一个关于灯塔的故事');

    await form.submit({ ...form.initialValues, genre: '科幻' });
    await runner.whenIdle();
    const view = stages.getCreativeView(work.id);
    assert.equal(view.versions.length, 2);
    assert.equal(view.params?.genre, '科幻');
    assert.deepEqual(started, [work.id, work.id]);
  } finally {
    database.close();
  }
});
