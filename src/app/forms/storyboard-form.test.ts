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
import { EMPTY_PROFILE } from '../../domain/models/generation-profile';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../domain/ports/testing/memory-secret-store';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { SqliteGenerationProfileRepository } from '../../infra/database/sqlite-generation-profile-repository';
import { SqliteProviderRepository } from '../../infra/database/sqlite-provider-repository';
import { SqliteScreenplayRepository } from '../../infra/database/sqlite-screenplay-repository';
import { GenerationProfileService } from '../services/generation-profile-service';
import { ProviderService } from '../services/provider-service';
import { createServiceFixture } from '../services/testing/service-fixture';
import { FormDefinition } from './form-definition';
import { STORYBOARD_FORM_NAMES, createStoryboardFormCatalog } from './storyboard-form';
import { DEFAULT_TEXT_MODEL_OPTION, createFakeTextModels } from './testing/fake-text-models';

const CREATIVE_PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };
const SCREENPLAY_PARAMS = { maxEpisodeDurationSeconds: '60', maxEpisodes: '3' };
const FAKE_MODEL_LABEL = '假服务商 · 假视频模型（单次最长 10 秒）';

/** 创建夹具与作品，创意已确认；approveScreenplay 为 true 时剧本也已确认；hasModel 为 false 时没有可用的视频模型（未配置密钥）。 */
async function createFixture(kind: '单个短视频' | '多集短片', approveScreenplay = true, hasModel = true) {
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
  const providerRepository = new SqliteProviderRepository(fixture.database);
  const providers = new ProviderService({
    repository: providerRepository,
    registry: new ProviderRegistry().register(new FakeVideoProvider()),
    secrets: new MemorySecretStore()
  });
  providers.syncCatalog();
  const [providerView] = await providers.listViews();
  if (hasModel) {
    await providers.setApiKey({ providerId: providerView.id, apiKey: 'sk-test' });
  }
  const modelId = providerView.models[0].id;
  const profiles = new GenerationProfileService({
    profiles: new SqliteGenerationProfileRepository(fixture.database),
    works: fixture.works,
    projects: fixture.projects,
    screenplays: new SqliteScreenplayRepository(fixture.database),
    models: providerRepository
  });
  const started: Array<[number, readonly number[]]> = [];
  const picked: number[] = [];
  const { textModels, saved: savedTextModels } = createFakeTextModels();
  const catalog = createStoryboardFormCatalog({
    projects: fixture.projects,
    works: fixture.works,
    storyboards: fixture.storyboards,
    textModels,
    profiles,
    providers,
    onStarted: (workId, episodeIds) => started.push([workId, episodeIds]),
    onPicked: (workId) => picked.push(workId)
  });
  const open = async (params: unknown, name: string = STORYBOARD_FORM_NAMES.start): Promise<FormDefinition> => {
    const factory = catalog.get(name);
    assert.ok(factory);
    return factory(params);
  };
  return { ...fixture, work, started, picked, savedTextModels, open, profiles, modelId };
}

test('字段：多集作品可选集，单个短视频或指定了集时不显示选择；新建时带默认值', async () => {
  const series = await createFixture('多集短片');
  const single = await createFixture('单个短视频');
  try {
    const seriesForm = await series.open({ workId: series.work.id });
    assert.deepEqual(seriesForm.schema.fields.map((field) => field.key), [
      'episodes',
      'textModel',
      'videoModel',
      'aspectRatio',
      'resolution',
      'visualStyle',
      'minShotSeconds',
      'maxShotSeconds',
      'groupMaxSeconds',
      'maxShots',
      'continuity',
      'audioMode',
      'audioElements',
      'extra'
    ]);
    assert.deepEqual(seriesForm.schema.fields[0].options, ['第 1 集 第一集', '第 2 集 第二集']);
    assert.equal(seriesForm.schema.title, '生成分镜脚本：作品甲');
    assert.equal(seriesForm.initialValues.textModel, DEFAULT_TEXT_MODEL_OPTION);
    assert.equal(seriesForm.initialValues.continuity, '由 AI 判断');
    assert.equal(seriesForm.initialValues.audioMode, '模型原生生成');
    assert.deepEqual(JSON.parse(seriesForm.initialValues.episodes), ['第 1 集 第一集', '第 2 集 第二集']);

    const episodeId = series.storyboards.listEpisodeStatuses(series.work.id)[1].episodeId;
    const oneEpisode = await series.open({ workId: series.work.id, episodeId });
    assert.ok(!oneEpisode.schema.fields.some((field) => field.key === 'episodes'));
    assert.equal(oneEpisode.schema.title, '生成分镜脚本：作品甲 › 第 2 集 第二集');

    assert.ok(!(await single.open({ workId: single.work.id })).schema.fields.some((field) => field.key === 'episodes'));
  } finally {
    series.database.close();
    single.database.close();
  }
});

test('打开：剧本未确认、作品或集不存在时报错', async () => {
  const { database, open, work } = await createFixture('单个短视频', false);
  try {
    await assert.rejects(open({ workId: work.id }), (error) => error instanceof ValidationError && /请先确认剧本/.test(error.message));
    await assert.rejects(open({ workId: 999 }), NotFoundError);
    await assert.rejects(open({}), ValidationError);
  } finally {
    database.close();
  }

  const approved = await createFixture('单个短视频');
  try {
    await assert.rejects(approved.open({ workId: approved.work.id, episodeId: 9999 }), ValidationError);
  } finally {
    approved.database.close();
  }
});

test('提交：为所选集各启动一份并通知页面；至少选一集；输入不合法时返回字段错误；重新生成时带出上次的参数', async () => {
  const { database, open, work, started, storyboards, runner } = await createFixture('多集短片');
  try {
    const form = await open({ workId: work.id });
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
    assert.deepEqual(started, [[work.id, [second.episodeId]]]);
    assert.deepEqual(storyboards.listEpisodeStatuses(work.id).map((status) => status.display), ['none', 'pending']);

    const again = await open({ workId: work.id });
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

    const form = await open({}, STORYBOARD_FORM_NAMES.pick);
    assert.deepEqual(form.schema.fields[0].options, ['项目甲 › 作品甲']);
    assert.deepEqual(form.initialValues, { work: '项目甲 › 作品甲' });
    assert.throws(() => form.submit({ work: '' }), ValidationError);
    form.submit({ work: '项目甲 › 作品甲' });
    assert.deepEqual(picked, [work.id]);

    await assert.rejects(open({ projectId: other.id }, STORYBOARD_FORM_NAMES.pick), ValidationError);
  } finally {
    database.close();
  }
});

test('提交：默认勾选全部集时，为每一集各启动一份并把所有集通知页面', async () => {
  const { database, open, work, started, storyboards, runner } = await createFixture('多集短片');
  try {
    const form = await open({ workId: work.id });
    await form.submit({ ...form.initialValues });
    await runner.whenIdle();
    const ids = storyboards.listEpisodeStatuses(work.id).map((status) => status.episodeId);
    assert.deepEqual(started, [[work.id, ids]]);
    assert.deepEqual(storyboards.listEpisodeStatuses(work.id).map((status) => status.display), ['pending', 'pending']);
  } finally {
    database.close();
  }
});

test('目标模型：没有可用视频模型时不显示模型、画幅、分辨率三项，也能照常提交', async () => {
  const { database, open, work, started, runner, profiles } = await createFixture('单个短视频', true, false);
  try {
    const form = await open({ workId: work.id });
    assert.ok(!form.schema.fields.some((field) => ['videoModel', 'aspectRatio', 'resolution'].includes(field.key)));
    await form.submit({ ...form.initialValues });
    await runner.whenIdle();
    assert.equal(started.length, 1);
    assert.deepEqual(profiles.getWorkDefaults(work.id).values, EMPTY_PROFILE);
  } finally {
    database.close();
  }
});

test('目标模型：选项取自可用模型，保存为作品默认并在下次打开时作为初始值，单组最长时长默认值不超过模型上限', async () => {
  const { database, open, work, started, runner, profiles, modelId, text } = await createFixture('单个短视频');
  try {
    const form = await open({ workId: work.id });
    const field = (key: string) => form.schema.fields.find((item) => item.key === key);
    assert.deepEqual(field('videoModel')?.options, [FAKE_MODEL_LABEL]);
    assert.deepEqual(field('aspectRatio')?.options, ['16:9', '9:16']);
    assert.deepEqual(field('resolution')?.options, ['720P', '1080P']);
    assert.deepEqual([form.initialValues.videoModel, form.initialValues.aspectRatio, form.initialValues.resolution], ['', '', '']);
    assert.equal(form.initialValues.groupMaxSeconds, '15');

    await form.submit({ ...form.initialValues, videoModel: FAKE_MODEL_LABEL, aspectRatio: '9:16', resolution: '720P', groupMaxSeconds: '10' });
    await runner.whenIdle();
    assert.equal(started.length, 1);
    assert.ok(text.requests.at(-1)?.user.includes('目标视频画幅为 9:16'), '所选画幅传给了分镜提示词');
    assert.deepEqual(profiles.getWorkDefaults(work.id).values, { ...EMPTY_PROFILE, modelId, aspectRatio: '9:16', resolution: '720P' });

    const again = await open({ workId: work.id });
    assert.deepEqual([again.initialValues.videoModel, again.initialValues.aspectRatio, again.initialValues.resolution], [FAKE_MODEL_LABEL, '9:16', '720P']);
    assert.equal(again.initialValues.groupMaxSeconds, '10');
  } finally {
    database.close();
  }
});

test('目标模型：先选了模型的作品，新表单的单组最长时长默认值取模型上限', async () => {
  const { database, open, work, profiles, modelId } = await createFixture('单个短视频');
  try {
    profiles.saveWorkDefaults(work.id, { modelId });
    const form = await open({ workId: work.id });
    assert.equal(form.initialValues.videoModel, FAKE_MODEL_LABEL);
    assert.equal(form.initialValues.groupMaxSeconds, '10');
  } finally {
    database.close();
  }
});

test('目标模型：不满足能力或不在列表中时返回字段错误，不启动生成也不改动作品默认；没有改动时不写入', async () => {
  const { database, open, work, started, runner, profiles } = await createFixture('单个短视频');
  try {
    const form = await open({ workId: work.id });
    const rejection = (values: Record<string, string>, key: string) =>
      assert.rejects(Promise.resolve(form.submit({ ...form.initialValues, ...values })), (error) => error instanceof ValidationError && error.fieldErrors[key] !== undefined);
    await rejection({ videoModel: FAKE_MODEL_LABEL, aspectRatio: '1:1' }, 'aspectRatio');
    await rejection({ videoModel: FAKE_MODEL_LABEL, resolution: '4K' }, 'resolution');
    await rejection({ videoModel: FAKE_MODEL_LABEL, groupMaxSeconds: '15' }, 'groupMaxSeconds');
    await rejection({ videoModel: '不存在的模型' }, 'videoModel');
    assert.deepEqual(started, []);
    assert.deepEqual(profiles.getWorkDefaults(work.id).values, EMPTY_PROFILE);

    await form.submit({ ...form.initialValues });
    await runner.whenIdle();
    assert.equal(started.length, 1);
    assert.deepEqual(profiles.getWorkDefaults(work.id).values, EMPTY_PROFILE);
  } finally {
    database.close();
  }
});

test('文本模型：初始值为作品当前的选择，所选模型保存为作品的选择；选项无效或没能启动时作品选择不变', async () => {
  const { database, open, work, savedTextModels, runner, started } = await createFixture('单个短视频');
  try {
    savedTextModels.set(work.id, 'copilot:');
    const form = await open({ workId: work.id });
    assert.equal(form.initialValues.textModel, 'Copilot · 自动');
    assert.deepEqual(form.schema.fields.find((field) => field.key === 'textModel')?.options, [DEFAULT_TEXT_MODEL_OPTION, 'Copilot · 自动', '假服务商 · 假文本模型']);

    await assert.rejects(
      Promise.resolve(form.submit({ ...form.initialValues, textModel: '已被停用的模型' })),
      (error) => error instanceof ValidationError && error.fieldErrors.textModel !== undefined
    );
    // 参数无效、没能启动生成：作品保持原选择。
    await assert.rejects(Promise.resolve(form.submit({ ...form.initialValues, maxShots: '0', textModel: '假服务商 · 假文本模型' })), ValidationError);
    assert.equal(savedTextModels.get(work.id), 'copilot:');
    assert.deepEqual(started, []);

    await form.submit({ ...form.initialValues, textModel: '假服务商 · 假文本模型' });
    await runner.whenIdle();
    assert.equal(savedTextModels.get(work.id), 'model:fake/fake-text');
  } finally {
    database.close();
  }
});
