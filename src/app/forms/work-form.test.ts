// ------------------------------------------------------------------------
// 名称：work-form.test.ts
// 说明：作品表单的自动化测试：字段随素材来源变化、所属项目的选择与默认值、提交创建作品并启动生成、失败回滚、重新生成的初始值、编辑作品。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：使用内存数据库、真实的执行器与脚本化的假文本生成端口。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, TextGenerationError, ValidationError } from '../../domain/errors';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { createServiceFixture } from '../services/testing/service-fixture';
import { DUPLICATE_WORK_NAME_MESSAGE } from '../services/work-service';
import { FormDefinition } from './form-definition';
import { WORK_FORM_NAMES, createWorkFormCatalog } from './work-form';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const VALID_VALUES = {
  projectName: '项目甲',
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
test('新建表单：字段随素材来源变化，标题带素材来源，初始值含默认项目、形态与字数', () => {
  const { database, project, open } = createFixture();
  try {
    const keysOf = (sourceType: string) => open(WORK_FORM_NAMES.create, { projectId: project.id, sourceType }).schema.fields.map((field) => field.key);
    const common = ['genre', 'tone', 'chapterMinWords', 'chapterMaxWords', 'maxChapters'];
    assert.deepEqual(keysOf('text'), ['projectName', 'workName', 'kind', 'idea', ...common, 'extra']);
    assert.deepEqual(keysOf('image'), ['projectName', 'workName', 'kind', 'images', ...common, 'preserve', 'extra']);
    assert.deepEqual(keysOf('novel'), ['projectName', 'workName', 'kind', 'novelFile', ...common, 'preserve', 'adjust', 'extra']);

    const form = open(WORK_FORM_NAMES.create, { sourceType: 'image' });
    assert.equal(form.schema.title, '新建作品（灵感图片）');
    assert.equal(form.schema.fields.find((field) => field.key === 'images')?.control, 'file');
    assert.deepEqual(form.schema.fields.find((field) => field.key === 'projectName')?.options, ['项目甲']);
    assert.equal(form.checkField, undefined, '所属项目可能还没选，重名只在提交时检查');
    // 只有一个项目时自动选中它。
    assert.deepEqual(form.initialValues, {
      projectName: '项目甲',
      kind: '单个短视频',
      chapterMinWords: '100',
      chapterMaxWords: '2500',
      maxChapters: '20'
    });
  } finally {
    database.close();
  }
});

test('默认项目：入口指定的项目优先；多个项目且没有指定时留空让用户选；可以提交到所选项目', async () => {
  const { database, projects, works, runner, open } = createFixture();
  try {
    const second = projects.createProject({ name: '项目乙' });
    assert.equal(open(WORK_FORM_NAMES.create, { sourceType: 'text' }).initialValues.projectName, '');
    assert.equal(open(WORK_FORM_NAMES.create, { sourceType: 'text', projectId: second.id }).initialValues.projectName, '项目乙');
    assert.equal(open(WORK_FORM_NAMES.create, { sourceType: 'text', projectId: 999 }).initialValues.projectName, '');

    const form = open(WORK_FORM_NAMES.create, { sourceType: 'text' });
    await assert.rejects(
      () => submit(form, { ...VALID_VALUES, projectName: '' }),
      (error) => error instanceof ValidationError && 'projectName' in error.fieldErrors
    );
    await form.submit({ ...VALID_VALUES, projectName: '项目乙' });
    await runner.whenIdle();
    assert.equal(works.listWorks(second.id).length, 1);
  } finally {
    database.close();
  }
});

test('打开参数：没有项目、素材来源无效、作品不存在时被拒绝', () => {
  const { database, projects, project, open } = createFixture();
  try {
    assert.throws(() => open(WORK_FORM_NAMES.create, { sourceType: 'video' }), ValidationError);
    assert.throws(() => open(WORK_FORM_NAMES.create, {}), ValidationError);
    assert.throws(() => open(WORK_FORM_NAMES.regenerate, { workId: 999 }), NotFoundError);
    assert.throws(() => open(WORK_FORM_NAMES.edit, { workId: 999 }), NotFoundError);
    projects.deleteProject(project.id);
    assert.throws(() => open(WORK_FORM_NAMES.create, { sourceType: 'text' }), ValidationError);
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

    // 同名作品：提交返回重名提示。
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

/** 创建一个作品（不启动生成），返回它。 */
function addWork(fixture: ReturnType<typeof createFixture>, name: string, kind: '单个短视频' | '多集短片' = '单个短视频') {
  return fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: name, kind }, 'text'));
}

test('编辑作品：只有名称和形态字段，初始值为现有内容，重名检查排除自身', async () => {
  const fixture = createFixture();
  try {
    const work = addWork(fixture, '作品甲');
    addWork(fixture, '作品乙');
    const form = fixture.open(WORK_FORM_NAMES.edit, { workId: work.id });
    assert.equal(form.schema.title, '编辑作品：作品甲');
    assert.deepEqual(form.schema.fields.map((field) => field.key), ['workName', 'kind']);
    assert.deepEqual(form.initialValues, { workName: '作品甲', kind: '单个短视频' });
    assert.equal(form.checkField?.('workName', '作品甲'), undefined);
    assert.equal(form.checkField?.('workName', '作品乙'), DUPLICATE_WORK_NAME_MESSAGE);

    await assert.rejects(() => submit(form, { workName: '作品乙', kind: '单个短视频' }), (error) => error instanceof Error && error.message === DUPLICATE_WORK_NAME_MESSAGE);
    await assert.rejects(() => submit(form, { workName: '', kind: '单个短视频' }), ValidationError);
    await assert.rejects(() => submit(form, { workName: '新名字', kind: '未知' }), ValidationError);
    assert.equal(fixture.works.getWork(work.id).name, '作品甲');
  } finally {
    fixture.database.close();
  }
});

test('编辑图片作品：带出已有图片，可删除、新增、调整顺序后整体替换；至少保留 1 张', async () => {
  const fixture = createFixture();
  try {
    const { database, works, project, open } = fixture;
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
    const item = (name: string, bytes: Buffer) => ({ name, mimeType: 'application/octet-stream', size: bytes.length, data: bytes.toString('base64') });
    const work = works.createWork(
      project.id,
      normalizeWorkCreation({ workName: '图片作品', kind: '单个短视频', images: JSON.stringify([item('a.png', PNG), item('b.jpg', JPEG)]) }, 'image')
    );

    const form = open(WORK_FORM_NAMES.edit, { workId: work.id });
    const imageField = form.schema.fields.find((field) => field.key === 'images');
    assert.deepEqual([imageField?.control, imageField?.preview, imageField?.multiple], ['file', 'image', true]);
    const shown = JSON.parse(form.initialValues.images) as Array<{ name: string; mimeType: string; size: number; data: string }>;
    assert.deepEqual(shown.map((file) => [file.name, file.mimeType, file.size]), [['a.png', 'image/png', PNG.length], ['b.jpg', 'image/jpeg', JPEG.length]]);

    // 删除第 1 张、再加一张新图并放到最前：库里按新顺序只剩这两张。
    const added = item('c.png', PNG);
    await form.submit({ workName: '图片作品', kind: '单个短视频', images: JSON.stringify([added, shown[1]]) });
    const names = () => (database.prepare("SELECT file_name FROM work_sources WHERE work_id = ? AND kind = 'image' ORDER BY sort_order").all(work.id) as Array<{ file_name: string }>).map((row) => row.file_name);
    assert.deepEqual(names(), ['c.png', 'b.jpg']);

    await assert.rejects(
      () => submit(form, { workName: '图片作品', kind: '单个短视频', images: '[]' }),
      (error) => error instanceof ValidationError && 'images' in error.fieldErrors
    );
    assert.deepEqual(names(), ['c.png', 'b.jpg']);
  } finally {
    fixture.database.close();
  }
});

test('编辑作品：文字灵感作品没有图片字段', () => {
  const fixture = createFixture();
  try {
    const form = fixture.open(WORK_FORM_NAMES.edit, { workId: addWork(fixture, '文字作品').id });
    assert.equal(form.schema.fields.some((field) => field.key === 'images'), false);
  } finally {
    fixture.database.close();
  }
});

test('编辑作品：改名同步第 1 集标题；单个短视频与多集短片互改时增删第 1 集', async () => {
  const fixture = createFixture();
  try {
    const { database, works, open } = fixture;
    const work = addWork(fixture, '作品甲');
    const episodeTitles = () => (database.prepare('SELECT title FROM episodes WHERE work_id = ? ORDER BY seq').all(work.id) as Array<{ title: string }>).map((row) => row.title);
    assert.deepEqual(episodeTitles(), ['作品甲']);

    await open(WORK_FORM_NAMES.edit, { workId: work.id }).submit({ workName: '新名字', kind: '单个短视频' });
    assert.equal(works.getWork(work.id).name, '新名字');
    assert.deepEqual(episodeTitles(), ['新名字']);

    await open(WORK_FORM_NAMES.edit, { workId: work.id }).submit({ workName: '新名字', kind: '多集短片' });
    assert.equal(works.getWork(work.id).kind, 'series');
    assert.deepEqual(episodeTitles(), []);

    await open(WORK_FORM_NAMES.edit, { workId: work.id }).submit({ workName: '回到单集', kind: '单个短视频' });
    assert.equal(works.getWork(work.id).kind, 'single');
    assert.deepEqual(episodeTitles(), ['回到单集']);
  } finally {
    fixture.database.close();
  }
});

test('编辑作品：剧本确认后形态锁定，表单不再有形态字段，提交里的形态被忽略', async () => {
  const fixture = createFixture();
  try {
    const { runs, works, open } = fixture;
    const work = addWork(fixture, '作品甲');
    const run = runs.create(
      { workId: work.id, stage: 'screenplay', episodeId: null, input: {}, sourceRunId: null, sourceRevision: null, modelInfo: null },
      '2026-10-01T00:00:00.000Z'
    );
    runs.markSucceeded(run.id, '2026-10-01T00:00:00.000Z');
    runs.approve(run.id, { reviewStatus: 'approved', isCurrent: true, revision: run.revision, approvedAt: '2026-10-01T00:00:00.000Z' });

    assert.equal(works.canChangeKind(work.id), false);
    const form = open(WORK_FORM_NAMES.edit, { workId: work.id });
    assert.deepEqual(form.schema.fields.map((field) => field.key), ['workName']);

    await form.submit({ workName: '改名', kind: '多集短片' });
    assert.deepEqual([works.getWork(work.id).name, works.getWork(work.id).kind], ['改名', 'single']);
  } finally {
    fixture.database.close();
  }
});
