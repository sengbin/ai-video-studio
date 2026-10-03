// ------------------------------------------------------------------------
// 名称：generation-service.test.ts
// 说明：视频生成应用服务的自动化测试：工作台清单与镜头组视图、分镜脚本确认门槛、按组提交（编译、校验、入队、提醒）、重复提交与并发提交（同一组只有一个进行中的任务）、超过模型时长的组、失败原因展示与再次生成、参考图绑定、重新分组与拆分合并、取消与结果路径、尾帧衔接、采用结果版本及后续组的过期提示、读取镜头组的全部历史成功版本、取消时带回通知平台失败的原因。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用真实的分镜脚本生成流程（生成后自动分组）、内存数据库、假适配器和假调度器。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, ValidationError } from '../../domain/errors';
import { EMPTY_PROFILE } from '../../domain/models/generation-profile';
import { VideoCapability } from '../../domain/models/model-capability';
import { VideoGenerationRequest } from '../../domain/ports/provider-adapters';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { FAKE_VIDEO_CAPABILITY, FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../domain/ports/testing/memory-secret-store';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteBindingRepository } from '../../infra/database/sqlite-binding-repository';
import { SqliteGenerationProfileRepository } from '../../infra/database/sqlite-generation-profile-repository';
import { SqliteGenerationRepository } from '../../infra/database/sqlite-generation-repository';
import { SqliteProviderRepository } from '../../infra/database/sqlite-provider-repository';
import { SqliteScreenplayRepository } from '../../infra/database/sqlite-screenplay-repository';
import { SqliteStoryboardRepository } from '../../infra/database/sqlite-storyboard-repository';
import { JobCancelResult, JobChange } from '../queue/job-queue';
import { standardResponder } from '../stages/testing/scripted-text';
import { AssetService } from './asset-service';
import { BindingService } from './binding-service';
import { ChangeNotifier } from './change-notifier';
import { GenerationService } from './generation-service';
import { ProviderService } from './provider-service';
import { createServiceFixture } from './testing/service-fixture';
import { MemoryAssetFileStore } from '../../domain/ports/testing/memory-asset-file-store';

const CREATIVE_PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };
const SCREENPLAY_PARAMS = { maxEpisodeDurationSeconds: '60', maxEpisodes: '3' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PARAMS = { aspectRatio: '16:9', resolution: '720P' };

/** 按能力严格检查分辨率的假适配器，用于验证被拒绝的镜头组。 */
class StrictFakeProvider extends FakeVideoProvider {
  override validate(request: VideoGenerationRequest): readonly string[] {
    const issues = [...super.validate(request)];
    if (request.resolution !== null && !FAKE_VIDEO_CAPABILITY.resolutions.includes(request.resolution)) {
      issues.push(`分辨率 ${request.resolution} 不在模型支持的范围内。`);
    }
    return issues;
  }
}

/** 创建完整夹具：作品、已生成的分镜脚本（待确认，自动分成 1 组 2 个镜头）、服务与假依赖。 */
async function createFixture(storyboardParams: Record<string, unknown> = {}, capability: VideoCapability = FAKE_VIDEO_CAPABILITY, withSecondModel = false) {
  const fixture = createServiceFixture(standardResponder);
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  const creative = await fixture.stages.startCreative(work.id, CREATIVE_PARAMS);
  await fixture.runner.whenIdle();
  fixture.stages.approve(creative.id);
  const screenplay = await fixture.screenplays.start(work.id, SCREENPLAY_PARAMS);
  await fixture.runner.whenIdle();
  fixture.stages.approve(screenplay.id);
  const episodeId = fixture.storyboards.listEpisodeStatuses(work.id)[0].episodeId;
  const [run] = await fixture.storyboards.start(work.id, [episodeId], storyboardParams);
  await fixture.runner.whenIdle();

  const { database } = fixture;
  const files = new MemoryAssetFileStore();
  const assetRepository = new SqliteAssetRepository(database, files);
  const providerRepository = new SqliteProviderRepository(database);
  const jobs = new SqliteGenerationRepository(database, files);
  const provider = new StrictFakeProvider([
    { code: 'fake-video', displayName: '假视频模型', kind: 'video', capability },
    ...(withSecondModel ? [{ code: 'fake-video-2', displayName: '第二个假视频模型', kind: 'video' as const, capability }] : [])
  ]);
  const secrets = new MemorySecretStore();
  const providers = new ProviderService({ repository: providerRepository, registry: new ProviderRegistry().register(provider), secrets });
  providers.syncCatalog();
  const [providerView] = await providers.listViews();
  await providers.setApiKey({ providerId: providerView.id, apiKey: 'sk-test' });
  const modelId = providerView.models[0].id;
  const secondModelId = withSecondModel ? providerView.models[1].id : 0;

  const pumps: number[] = [];
  const canceled: number[] = [];
  /** 假调度器取消任务时返回的结果，测试可改。 */
  const cancelOutcome: { value: JobCancelResult } = { value: { remoteCanceled: false } };
  const changes = new ChangeNotifier<JobChange>();
  const changed: JobChange[] = [];
  changes.subscribe((change) => changed.push(change));
  const storyboardRepository = new SqliteStoryboardRepository(database);
  const generation = new GenerationService({
    works: fixture.works,
    projects: fixture.projects,
    storyboardService: fixture.storyboards,
    runs: fixture.runs,
    screenplays: new SqliteScreenplayRepository(database),
    storyboards: storyboardRepository,
    bindings: new SqliteBindingRepository(database),
    assets: assetRepository,
    jobs,
    media: jobs,
    results: { save: async () => ({ filePath: 'x', sizeBytes: 1 }), resolvePath: (filePath) => `/store/${filePath}` },
    models: providerRepository,
    providers,
    profiles: new SqliteGenerationProfileRepository(database),
    scheduler: {
      pump: async () => {
        pumps.push(1);
      },
      cancel: async (jobId) => {
        canceled.push(jobId);
        return cancelOutcome.value;
      }
    },
    changes
  });
  const approve = (): void => {
    fixture.stages.approve(run.id);
  };
  const episode = () => generation.getEpisode(work.id, episodeId);
  const groupIds = (): number[] => episode().groups.map((group) => group.id);
  return { ...fixture, work, episodeId, run, generation, jobs, provider, providers, providerView, modelId, secondModelId, pumps, canceled, cancelOutcome, changed, assetRepository, storyboardRepository, approve, episode, groupIds };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** 提交指定的镜头组（缺省为全部）。 */
function submitGroups(fixture: Fixture, groupIds: number[] = fixture.groupIds(), params: Record<string, unknown> = {}) {
  return fixture.generation.submit({
    workId: fixture.work.id,
    episodeId: fixture.episodeId,
    groupIds,
    params: { modelId: fixture.modelId, ...PARAMS, ...params }
  });
}

/** 修改一个镜头的时长（保存时需要带全字段）。 */
function setShotSeconds(fixture: Fixture, shotId: number, durationSeconds: number): void {
  const shot = fixture.storyboards.getView(fixture.work.id, fixture.episodeId).shots.find((item) => item.id === shotId);
  assert.ok(shot);
  fixture.storyboards.saveShot(fixture.run.id, { ref: shotId, ...shot, durationSeconds, entityIds: [...shot.entityIds], sounds: [] });
}

test('工作台清单：列出有分镜脚本的作品与集，以及可用的视频模型、可选参数与单次最长时长', async () => {
  const fixture = await createFixture();
  try {
    const catalog = await fixture.generation.getCatalog();
    assert.equal(catalog.works.length, 1);
    assert.deepEqual([catalog.works[0].name, catalog.works[0].projectName], ['作品甲', '项目甲']);
    assert.deepEqual(catalog.works[0].episodes.map((episode) => [episode.seq, episode.display, episode.shotCount]), [[1, 'pending', 2]]);
    assert.deepEqual(catalog.models, [
      {
        id: fixture.modelId,
        displayName: '假视频模型',
        providerName: '假服务商',
        aspectRatios: FAKE_VIDEO_CAPABILITY.aspectRatios,
        resolutions: FAKE_VIDEO_CAPABILITY.resolutions,
        audioModes: FAKE_VIDEO_CAPABILITY.audioModes,
        audioElements: FAKE_VIDEO_CAPABILITY.audioElements,
        supportsSeed: true,
        supportsPromptExtend: false,
        duration: FAKE_VIDEO_CAPABILITY.duration,
        durationText: '2–10 秒',
        maxGroupSeconds: 10
      }
    ]);

    await fixture.providers.clearApiKey({ providerId: fixture.providerView.id });
    assert.deepEqual((await fixture.generation.getCatalog()).models, [], '没有密钥就没有可用模型');
  } finally {
    fixture.database.close();
  }
});

test('生成分镜脚本后自动分组：相邻镜头按单组最长时长打包成一组，视图带组内镜头、总时长与出场实体', async () => {
  const fixture = await createFixture();
  try {
    const view = fixture.episode();
    assert.equal(view.groupMaxSeconds, 15);
    assert.equal(view.groups.length, 1);
    const [group] = view.groups;
    assert.deepEqual(group.shots.map((shot) => [shot.seq, shot.durationSeconds]), [[1, 4], [2, 4]]);
    assert.equal(group.totalSeconds, 8);
    assert.deepEqual(group.entities.map((entity) => [entity.name, entity.bound]), [['灯塔', false], ['守夜人', false]]);
    assert.deepEqual(group.jobs, []);
  } finally {
    fixture.database.close();
  }
});

test('单组最长时长更短时分成多组', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    const view = fixture.episode();
    assert.equal(view.groupMaxSeconds, 4);
    assert.deepEqual(view.groups.map((group) => group.shots.map((shot) => shot.seq)), [[1], [2]]);
  } finally {
    fixture.database.close();
  }
});

test('分镜脚本未确认采用时不能生成，视图说明原因；确认后可以', async () => {
  const fixture = await createFixture();
  try {
    const before = fixture.episode();
    assert.equal(before.canGenerate, false);
    assert.match(before.blockReason ?? '', /还没有确认采用/);
    await assert.rejects(submitGroups(fixture), (error) => error instanceof ValidationError && /还没有确认采用/.test(error.message));

    fixture.approve();
    const after = fixture.episode();
    assert.deepEqual([after.canGenerate, after.blockReason], [true, null]);
  } finally {
    fixture.database.close();
  }
});

test('编辑已确认的镜头后分镜脚本回到待确认，分组保留，重新确认后才能再次生成', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const groupId = fixture.groupIds()[0];
    setShotSeconds(fixture, fixture.episode().groups[0].shots[0].id, 3);
    const blocked = fixture.episode();
    assert.equal(blocked.canGenerate, false);
    assert.deepEqual(blocked.groups.map((group) => group.id), [groupId], '分组还在');
    assert.equal(blocked.groups[0].totalSeconds, 7);
    fixture.approve();
    assert.equal(fixture.episode().canGenerate, true);
  } finally {
    fixture.database.close();
  }
});

test('新增、删除镜头后分组自动补全：放得下并入最后一组，放不下新开一组，组空了就删除', async () => {
  const fixture = await createFixture();
  try {
    const shot = fixture.storyboards.getView(fixture.work.id, fixture.episodeId).shots[0];
    const draft = { ...shot, entityIds: [], sounds: [], firstFrameMode: 'none' };
    const small = fixture.storyboards.addShot(fixture.run.id, { ...draft, durationSeconds: 5 });
    assert.deepEqual(fixture.episode().groups.map((group) => group.shots.length), [3], '8 + 5 秒仍不超过 15 秒');
    fixture.storyboards.addShot(fixture.run.id, { ...draft, durationSeconds: 5 });
    assert.deepEqual(fixture.episode().groups.map((group) => group.shots.map((item) => item.durationSeconds)), [[4, 4, 5], [5]], '再加 5 秒放不下，新开一组');

    fixture.storyboards.deleteShot(fixture.run.id, { ref: fixture.episode().groups[1].shots[0].id });
    fixture.storyboards.deleteShot(fixture.run.id, { ref: small });
    assert.deepEqual(fixture.episode().groups.map((group) => group.shots.length), [2], '空组被删除');
  } finally {
    fixture.database.close();
  }
});

test('提交：一组生成一条排队中的任务，快照含组内全部镜头与带时间段的提示词，提醒随结果返回，并通知队列', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    const result = await submitGroups(fixture);
    assert.equal(result.rejected.length, 0);
    assert.deepEqual(result.submitted.map((item) => [item.groupId, item.seq]), [[groupId, 1]]);
    assert.equal(fixture.pumps.length, 1);
    assert.deepEqual(fixture.changed, [{ jobId: result.submitted[0].jobId, groupId }]);

    const [job] = fixture.jobs.listJobsByGroups([groupId]);
    assert.deepEqual([job.status, job.attempt, job.modelId], ['queued', 1, fixture.modelId]);
    assert.deepEqual([job.snapshot.params.aspectRatio, job.snapshot.params.resolution, job.snapshot.params.audioMode, job.snapshot.params.durationSeconds], ['16:9', '720P', 'native', 8]);
    assert.equal(job.snapshot.storyboardRunId, fixture.run.id);
    assert.equal(job.snapshot.shotIds.length, 2);
    assert.match(job.snapshot.prompt, /分镜1（00:00-00:04）：.*\n分镜2（00:04-00:08）：/s);
    assert.ok(!job.snapshot.prompt.includes('背景音乐：'), '假模型不支持背景音乐，已忽略');
    assert.ok(job.snapshot.prompt.endsWith('负向清单：不要字幕，不要水印。'), '默认负向清单写在提示词末尾');
    assert.equal(job.snapshot.promptFormat, 2);
    assert.equal(fixture.episode().groups[0].jobs[0].promptFormat, 2);
    const warnings = result.submitted[0].warnings;
    assert.ok(warnings.some((warning) => warning.includes('“守夜人”还没有绑定资产')));
    assert.ok(!warnings.some((warning) => warning.includes('尾帧')), '组内第 2 个镜头的尾帧衔接在同一个视频里自然完成');
  } finally {
    fixture.database.close();
  }
});

test('重复提交：镜头组还有进行中的任务时被拒绝', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    await submitGroups(fixture);
    const again = await submitGroups(fixture);
    assert.equal(again.submitted.length, 0);
    assert.deepEqual(again.rejected.map((item) => [item.groupId, item.issues[0]]), [[groupId, '这一组正在生成，完成或取消后才能再次提交。']]);
  } finally {
    fixture.database.close();
  }
});

test('并发提交同一个镜头组：只产生一个进行中的任务，另一次被拒绝并说明原因', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    const [first, second] = await Promise.all([submitGroups(fixture), submitGroups(fixture)]);
    assert.deepEqual([first.submitted.length + second.submitted.length, first.rejected.length + second.rejected.length], [1, 1]);
    const rejected = [...first.rejected, ...second.rejected][0];
    assert.deepEqual([rejected.groupId, rejected.issues], [groupId, ['这一组正在生成，完成或取消后才能再次提交。']]);
    assert.equal(fixture.jobs.listJobsByGroups([groupId]).length, 1);
    assert.equal(fixture.pumps.length, 1, '只有成功提交的那次唤醒队列');
  } finally {
    fixture.database.close();
  }
});

test('提交时抢在检查之后插入：仓库的冲突转为这一组被拒绝，同一次提交里的其他组照常提交，不报错', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    await submitGroups(fixture, [first]);
    // 模拟检查之后、插入之前另一次提交已经写入：检查看不到进行中的任务，只有仓库的事务内检查与唯一索引能拦住。
    fixture.jobs.hasActiveJob = () => false;
    const result = await submitGroups(fixture, [first, second]);
    assert.deepEqual(result.submitted.map((item) => item.groupId), [second]);
    assert.deepEqual(result.rejected.map((item) => [item.groupId, item.issues]), [[first, ['这一组正在生成，完成或取消后才能再次提交。']]]);
    assert.equal(fixture.jobs.listJobsByGroups([first]).length, 1);
  } finally {
    fixture.database.close();
  }
});

test('超过模型单次最长时长的组被拒绝并说明怎么办，不创建任务；拆分后可以提交', async () => {
  const fixture = await createFixture();
  try {
    // 假模型单次最长 10 秒：把第 1 个镜头改成 8 秒，一组共 12 秒。
    setShotSeconds(fixture, fixture.episode().groups[0].shots[0].id, 8);
    fixture.approve();
    const [groupId] = fixture.groupIds();
    const result = await submitGroups(fixture);
    assert.equal(result.submitted.length, 0);
    assert.match(result.rejected[0].issues[0], /共 12 秒，超过所选模型单次最长 10 秒/);
    assert.equal(fixture.jobs.listJobsByGroups([groupId]).length, 0);
    assert.equal(fixture.pumps.length, 0, '没有可提交的组时不唤醒队列');

    fixture.generation.splitGroup({ workId: fixture.work.id, episodeId: fixture.episodeId, shotId: fixture.episode().groups[0].shots[1].id });
    const again = await submitGroups(fixture);
    assert.equal(again.submitted.length, 2);
  } finally {
    fixture.database.close();
  }
});

test('校验不通过的镜头组被拒绝并说明原因，不创建任务', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const result = await submitGroups(fixture, fixture.groupIds(), { resolution: '4K' });
    assert.equal(result.submitted.length, 0);
    assert.match(result.rejected[0].issues.join(), /分辨率 4K 不在模型支持的范围内/);
    assert.equal(fixture.jobs.listJobsByGroups(fixture.groupIds()).length, 0);
  } finally {
    fixture.database.close();
  }
});

test('提交请求不合法：模型不可用、镜头组不属于当前分镜脚本、作品不存在', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    await assert.rejects(submitGroups(fixture, fixture.groupIds(), { modelId: 999 }), (error) => error instanceof ValidationError && 'modelId' in error.fieldErrors);
    await assert.rejects(fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, groupIds: [1], params: { modelId: 'x' } }), ValidationError);

    const result = await submitGroups(fixture, [9999]);
    assert.deepEqual(result.rejected, [{ groupId: 9999, seq: 0, issues: ['镜头组不属于当前已确认的分镜脚本。'] }]);
    await assert.rejects(fixture.generation.submit({ workId: 9999, episodeId: 1, groupIds: [1], params: { modelId: fixture.modelId } }), NotFoundError);
  } finally {
    fixture.database.close();
  }
});

test('失败原因：视图带分类名称、平台原文和处理建议；修改后可再次生成，历史都保留', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    await submitGroups(fixture);
    const [job] = fixture.jobs.listJobsByGroups([groupId]);
    fixture.jobs.markFailed(job.id, { category: 'content_rejected', code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, 't');

    const failed = fixture.episode().groups[0].jobs[0];
    assert.deepEqual([failed.status, failed.statusLabel, failed.attempt], ['failed', '失败', 1]);
    assert.equal(failed.failure?.label, '内容审核未通过');
    assert.equal(failed.failure?.code, 'DataInspectionFailed');
    assert.equal(failed.failure?.message, 'Input data may contain inappropriate content.');
    assert.match(failed.failure?.hint ?? '', /编辑镜头/);
    assert.equal(failed.modelName, '假视频模型');

    const again = await submitGroups(fixture);
    assert.equal(again.submitted.length, 1);
    const history = fixture.episode().groups[0].jobs;
    assert.deepEqual(history.map((item) => [item.attempt, item.status]), [[2, 'queued'], [1, 'failed']]);
    assert.equal(history[1].failure?.label, '内容审核未通过');
  } finally {
    fixture.database.close();
  }
});

test('完成：视图带结果视频信息，可取得本机路径；不存在的结果报错', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    await submitGroups(fixture);
    const [job] = fixture.jobs.listJobsByGroups([groupId]);
    fixture.jobs.markSubmitted(job.id, 'r', 't');
    const saved = fixture.jobs.markSucceeded(job.id, { filePath: 'videos/1/1/1/1-1.mp4', remoteUrl: null, durationSeconds: 8, width: null, height: null, sizeBytes: 2048, hasAudio: true }, 't');

    const view = fixture.episode().groups[0].jobs[0];
    assert.deepEqual(view.result, { id: saved?.id, durationSeconds: 8, sizeBytes: 2048, hasAudio: true, isSelected: true });
    assert.equal(fixture.generation.getResultPath({ resultId: saved?.id }), '/store/videos/1/1/1/1-1.mp4');
    assert.throws(() => fixture.generation.getResultPath({ resultId: 999 }), NotFoundError);

    // 视图带提交时的参数与提示词；导出文件名由作品、集、组和次数组成，不含非法字符。
    assert.deepEqual([view.params.resolution, view.params.durationSeconds === null, view.shotCount > 0, view.prompt.length > 0], ['720P', false, true, true]);
    const file = fixture.generation.getResultFile({ resultId: saved?.id });
    assert.equal(file.path, '/store/videos/1/1/1/1-1.mp4');
    assert.equal(file.suggestedName, `${fixture.work.name}-第1集-第1组-第1次.mp4`);
    assert.doesNotMatch(file.suggestedName, /[\\/:*?"<>|]/);
    assert.throws(() => fixture.generation.getResultFile({ resultId: 999 }), NotFoundError);

    // 任务结束的通知：成功为信息，失败为警告；进行中和不存在的任务没有通知。
    assert.deepEqual(fixture.generation.describeFinishedJob(job.id), { status: 'succeeded', level: 'info', message: `「${fixture.work.name}」第 1 集第 1 组的视频已生成。` });
    assert.equal(fixture.generation.describeFinishedJob(9999), undefined);
    await submitGroups(fixture);
    const second = fixture.jobs.listJobsByGroups([groupId])[0];
    assert.equal(fixture.generation.describeFinishedJob(second.id), undefined);
    fixture.jobs.markFailed(second.id, { category: 'content_rejected', code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, 't');
    const failed = fixture.generation.describeFinishedJob(second.id);
    assert.equal(failed?.level, 'warning');
    assert.match(failed?.message ?? '', /第 1 集第 1 组生成失败：内容审核未通过。Input data/);
  } finally {
    fixture.database.close();
  }
});

test('绑定了形象资产的实体：参考图进入快照并在提示词开头说明图片编号，每个实体只列一次', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const bindings = new BindingService(new SqliteBindingRepository(fixture.database), fixture.assetRepository);
    const assets = new AssetService(fixture.assetRepository);
    const guard = fixture.storyboards.getView(fixture.work.id, fixture.episodeId).entities.find((entity) => entity.name === '守夜人');
    const asset = assets.createAsset('character', {
      name: '守夜人形象',
      files: JSON.stringify([{ name: 'a.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64'), width: 64, height: 64 }])
    }, { fileSource: 'upload' });
    bindings.bind({ episodeId: fixture.episodeId, entityId: guard?.id, assetId: asset.id });

    const view = fixture.episode();
    assert.deepEqual(view.groups[0].entities.map((entity) => [entity.name, entity.bound]), [['灯塔', false], ['守夜人', true]]);

    const result = await submitGroups(fixture);
    assert.equal(result.rejected.length, 0);
    const snapshot = fixture.jobs.listJobsByGroups([view.groups[0].id])[0].snapshot;
    assert.equal(snapshot.referenceImageFileIds.length, 1);
    assert.ok(snapshot.prompt.includes('守夜人形象参考图1。'));
    assert.ok(!result.submitted[0].warnings.some((warning) => warning.includes('“守夜人”还没有绑定资产')));
  } finally {
    fixture.database.close();
  }
});

test('重新分组：丢弃旧组按新的时长重新打包；有进行中的组时不能重新分组；历史随旧组清除', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const base = { workId: fixture.work.id, episodeId: fixture.episodeId };
    await submitGroups(fixture);
    assert.throws(() => fixture.generation.regroup({ ...base, maxSeconds: 4 }), (error) => error instanceof ValidationError && /正在生成/.test(error.message));

    const [oldGroupId] = fixture.groupIds();
    const [job] = fixture.jobs.listJobsByGroups([oldGroupId]);
    fixture.jobs.markCanceled(job.id, 't');
    fixture.generation.regroup({ ...base, maxSeconds: 4 });
    const view = fixture.episode();
    assert.deepEqual(view.groups.map((group) => group.shots.map((shot) => shot.seq)), [[1], [2]]);
    assert.ok(!view.groups.some((group) => group.id === oldGroupId));
    assert.equal(fixture.jobs.findJob(job.id), undefined, '旧组的生成记录一并清除');

    fixture.generation.regroup(base);
    assert.deepEqual(fixture.episode().groups.map((group) => group.shots.length), [2], '缺省使用生成分镜脚本时设定的 15 秒');
    assert.throws(() => fixture.generation.regroup({ ...base, maxSeconds: 1 }), ValidationError);
    assert.throws(() => fixture.generation.regroup({ ...base, maxSeconds: 'x' }), ValidationError);
  } finally {
    fixture.database.close();
  }
});

test('拆分与合并：在镜头之前拆组、并入上一组；已有生成记录的组不能调整', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const base = { workId: fixture.work.id, episodeId: fixture.episodeId };
    const [first, second] = fixture.episode().groups[0].shots;
    assert.throws(() => fixture.generation.splitGroup({ ...base, shotId: first.id }), ValidationError, '组内第一个镜头不用拆');

    fixture.generation.splitGroup({ ...base, shotId: second.id });
    const split = fixture.episode().groups;
    assert.deepEqual(split.map((group) => group.shots.map((shot) => shot.seq)), [[1], [2]]);
    assert.throws(() => fixture.generation.mergeGroup({ ...base, groupId: split[0].id }), ValidationError, '第一组没有上一组');

    fixture.generation.mergeGroup({ ...base, groupId: split[1].id });
    assert.deepEqual(fixture.episode().groups.map((group) => [group.id, group.shots.length]), [[split[0].id, 2]]);

    // 有了生成记录后，拆分和合并都被拒绝。
    await submitGroups(fixture);
    assert.throws(() => fixture.generation.splitGroup({ ...base, shotId: second.id }), (error) => error instanceof ValidationError && /已经有生成记录/.test(error.message));
  } finally {
    fixture.database.close();
  }
});

test('合并时上一组有生成记录同样被拒绝', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const base = { workId: fixture.work.id, episodeId: fixture.episodeId };
    const [firstGroup, secondGroup] = fixture.groupIds();
    await submitGroups(fixture, [firstGroup]);
    assert.throws(() => fixture.generation.mergeGroup({ ...base, groupId: secondGroup }), (error) => error instanceof ValidationError && /已经有生成记录/.test(error.message));
    assert.equal(fixture.groupIds().length, 2);
  } finally {
    fixture.database.close();
  }
});

test('取消：交给调度器，任务标识不合法时报错', async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(await fixture.generation.cancel({ jobId: 7 }), { remoteCanceled: false });
    assert.deepEqual(fixture.canceled, [7]);
    assert.throws(() => fixture.generation.cancel({ jobId: 'x' }), ValidationError);

    // 通知平台取消失败的原因原样带回，页面据此提示平台上的任务可能仍在计费。
    fixture.cancelOutcome.value = { remoteCanceled: false, remoteCancelError: '平台返回 500' };
    assert.deepEqual(await fixture.generation.cancel({ jobId: 8 }), { remoteCanceled: false, remoteCancelError: '平台返回 500' });
  } finally {
    fixture.database.close();
  }
});

test('订阅任务变化：提交时通知，取消订阅后不再通知', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const received: number[] = [];
    const unsubscribe = fixture.generation.onDidChangeJobs((change) => received.push(change.jobId));
    const [first, second] = fixture.groupIds();
    await submitGroups(fixture, [first]);
    unsubscribe();
    await submitGroups(fixture, [second]);
    assert.equal(received.length, 1);
  } finally {
    fixture.database.close();
  }
});

/** 生成一组并让它成功（写入结果视频，自动采用）。 */
async function finishGroup(fixture: Fixture, groupId: number) {
  await submitGroups(fixture, [groupId]);
  const [job] = fixture.jobs.listJobsByGroups([groupId]);
  fixture.jobs.markSubmitted(job.id, 'r', 't');
  const result = fixture.jobs.markSucceeded(job.id, { filePath: `videos/${job.id}.mp4`, remoteUrl: null, durationSeconds: 4, width: null, height: null, sizeBytes: 10, hasAudio: true }, 't');
  assert.ok(result);
  return { job, result };
}

const FRAME_BASE64 = Buffer.from([1, 2, 3]).toString('base64');

test('尾帧衔接：同一次提交里后一组等待前一组（与点选顺序无关），快照不带参考图，视图说明在等什么', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    const result = await submitGroups(fixture, [second, first]);
    assert.equal(result.rejected.length, 0);
    assert.deepEqual(result.submitted.map((item) => item.seq), [1, 2]);

    const [firstJob] = fixture.jobs.listJobsByGroups([first]);
    const [secondJob] = fixture.jobs.listJobsByGroups([second]);
    assert.deepEqual([firstJob.status, firstJob.prevJobId, firstJob.firstFrameId], ['queued', null, null]);
    assert.deepEqual([secondJob.status, secondJob.prevJobId, secondJob.firstFrameId], ['waiting', firstJob.id, null]);
    assert.deepEqual([secondJob.snapshot.referenceImageFileIds, secondJob.snapshot.referenceAudioFileIds], [[], []]);

    const views = fixture.episode().groups.map((group) => group.jobs[0]);
    assert.deepEqual([views[0].usesPreviousTail, views[0].waitNote], [false, null]);
    assert.equal(views[1].usesPreviousTail, true);
    assert.match(views[1].waitNote ?? '', /等待上一组生成完成/);
  } finally {
    fixture.database.close();
  }
});

test('尾帧衔接：上一组还没有任何生成结果时拒绝，不创建任务', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [, second] = fixture.groupIds();
    const result = await submitGroups(fixture, [second]);
    assert.equal(result.submitted.length, 0);
    assert.match(result.rejected[0].issues[0], /上一组（第 1 组）还没有生成结果/);
    assert.equal(fixture.jobs.listJobsByGroups([second]).length, 0);
  } finally {
    fixture.database.close();
  }
});

test('尾帧衔接：模型不支持首帧输入时拒绝并说明怎么办', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' }, { ...FAKE_VIDEO_CAPABILITY, firstFrame: false });
  try {
    fixture.approve();
    const result = await submitGroups(fixture);
    assert.deepEqual(result.submitted.map((item) => item.seq), [1], '第 1 组不依赖尾帧，照常提交');
    assert.match(result.rejected[0].issues[0], /不支持首帧输入.*首帧来源改为“无”/);
  } finally {
    fixture.database.close();
  }
});

test('尾帧衔接：上一组已有结果但没有尾帧时等待截取；保存尾帧后唤醒队列，不再待截取', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    const { job, result } = await finishGroup(fixture, first);
    assert.deepEqual(fixture.generation.listPendingTailFrames(), [], '没有任务在等，不需要截取');

    await submitGroups(fixture, [second]);
    const [waiting] = fixture.jobs.listJobsByGroups([second]);
    assert.deepEqual([waiting.status, waiting.prevJobId, waiting.firstFrameId], ['waiting', job.id, null]);
    assert.match(fixture.episode().groups[1].jobs[0].waitNote ?? '', /正在从视频截取尾帧/);
    assert.deepEqual(fixture.generation.listPendingTailFrames(), [{ resultId: result.id }]);

    const pumpsBefore = fixture.pumps.length;
    assert.deepEqual(fixture.generation.saveTailFrame({ resultId: result.id, mimeType: 'image/jpeg', width: 64, height: 36, data: FRAME_BASE64 }), { saved: true });
    assert.equal(fixture.pumps.length, pumpsBefore + 1);
    const frameId = fixture.jobs.findResultFrameId(result.id);
    assert.ok(frameId !== undefined);
    assert.deepEqual(Array.from(fixture.jobs.readResultFrame(frameId)?.data ?? []), [1, 2, 3]);
    assert.deepEqual(fixture.generation.listPendingTailFrames(), []);
  } finally {
    fixture.database.close();
  }
});

test('尾帧衔接：上一组的尾帧已就绪时，这一组直接排队并带着首帧', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    const { job, result } = await finishGroup(fixture, first);
    fixture.generation.saveTailFrame({ resultId: result.id, mimeType: 'image/png', width: 64, height: 36, data: FRAME_BASE64 });
    const frameId = fixture.jobs.findResultFrameId(result.id);

    await submitGroups(fixture, [second]);
    const [queued] = fixture.jobs.listJobsByGroups([second]);
    assert.deepEqual([queued.status, queued.prevJobId, queued.firstFrameId], ['queued', job.id, frameId]);
    const view = fixture.episode().groups[1].jobs[0];
    assert.deepEqual([view.usesPreviousTail, view.waitNote], [true, null]);
    assert.match(queued.snapshot.warnings.join(), /尾帧作首帧.*不传参考素材/);
  } finally {
    fixture.database.close();
  }
});

test('采用结果版本：同一组只有一个采用的版本，切换后视图与通知同步更新；不存在的结果或不合法的标识报错', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    const first = await finishGroup(fixture, groupId);
    const second = await finishGroup(fixture, groupId);
    assert.deepEqual([first.result.isSelected, second.result.isSelected], [true, false], '第一个成功的结果自动采用');
    assert.equal(fixture.episode().groups[0].selectedResultId, first.result.id);

    const changesBefore = fixture.changed.length;
    assert.deepEqual(fixture.generation.selectResult({ resultId: second.result.id }), { selected: true });
    const [group] = fixture.episode().groups;
    assert.equal(group.selectedResultId, second.result.id);
    assert.deepEqual(group.jobs.map((job) => [job.id, job.result?.isSelected]), [[second.job.id, true], [first.job.id, false]]);
    assert.deepEqual(fixture.changed.slice(changesBefore), [{ jobId: second.job.id, groupId, quiet: true }], '只刷新界面，不弹任务完成的通知');

    fixture.generation.selectResult({ resultId: second.result.id });
    assert.equal(fixture.changed.length, changesBefore + 1, '重复采用同一个结果不再通知');
    assert.throws(() => fixture.generation.selectResult({ resultId: 999 }), NotFoundError);
    assert.throws(() => fixture.generation.selectResult({ resultId: 'x' }), ValidationError);
  } finally {
    fixture.database.close();
  }
});

test('采用结果版本：任务很多时，被采用的较早任务仍留在视图里', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    const first = await finishGroup(fixture, groupId);
    for (let index = 0; index < 11; index += 1) {
      await finishGroup(fixture, groupId);
    }
    const jobIds = fixture.episode().groups[0].jobs.map((job) => job.id);
    assert.equal(jobIds.length, 11, '最新的 10 条加上被采用的那一条');
    assert.equal(jobIds[jobIds.length - 1], first.job.id);
  } finally {
    fixture.database.close();
  }
});

test('结果版本页：读取该组全部历史成功版本（不受视图只显示最近 10 条任务的限制），失败的任务不在其中；组不属于这一集时报错', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [groupId, otherGroupId] = fixture.groupIds();
    const finished: Array<Awaited<ReturnType<typeof finishGroup>>> = [];
    for (let index = 0; index < 12; index += 1) {
      finished.push(await finishGroup(fixture, groupId));
    }
    await submitGroups(fixture, [groupId]);
    const [failedJob] = fixture.jobs.listJobsByGroups([groupId]);
    fixture.jobs.markFailed(failedJob.id, { category: 'server', code: null, message: 'x' }, 't');
    await finishGroup(fixture, otherGroupId);

    assert.equal(fixture.episode().groups[0].jobs.length, 11, '工作台视图最多带最近 10 条任务加被采用的那一条');
    const versions = fixture.generation.getGroupVersions({ workId: fixture.work.id, episodeId: fixture.episodeId, groupId });
    assert.equal(versions.length, 12);
    assert.deepEqual(versions.map((job) => job.id), finished.map((item) => item.job.id).reverse(), '最新的在前');
    assert.ok(versions.every((job) => job.status === 'succeeded' && job.result !== null && job.prompt.length > 0));
    assert.deepEqual(versions.filter((job) => job.result?.isSelected).map((job) => job.id), [finished[0].job.id], '第一个成功的版本被采用');

    assert.throws(() => fixture.generation.getGroupVersions({ workId: fixture.work.id, episodeId: fixture.episodeId, groupId: 99999 }), NotFoundError);
    assert.throws(() => fixture.generation.getGroupVersions({ workId: fixture.work.id, episodeId: fixture.episodeId, groupId: 'x' }), ValidationError);
    assert.throws(() => fixture.generation.getGroupVersions({ workId: 99999, episodeId: fixture.episodeId, groupId }), NotFoundError);
  } finally {
    fixture.database.close();
  }
});

test('采用结果版本：上一组改用其他版本后，接在旧尾帧之后采用的这一组提示画面可能不连贯，改回后提示消失', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    const firstDone = await finishGroup(fixture, first);
    fixture.generation.saveTailFrame({ resultId: firstDone.result.id, mimeType: 'image/png', width: 64, height: 36, data: FRAME_BASE64 });
    await submitGroups(fixture, [second]);
    const [secondJob] = fixture.jobs.listJobsByGroups([second]);
    fixture.jobs.markSubmitted(secondJob.id, 'r2', 't');
    fixture.jobs.markSucceeded(secondJob.id, { filePath: 'videos/second.mp4', remoteUrl: null, durationSeconds: 4, width: null, height: null, sizeBytes: 10, hasAudio: true }, 't');

    const again = await finishGroup(fixture, first);
    assert.deepEqual(fixture.episode().groups.map((group) => group.staleNote), [null, null], '重新生成上一组但没有改用，不算过期');

    fixture.generation.selectResult({ resultId: again.result.id });
    const [, stale] = fixture.episode().groups;
    assert.match(stale.staleNote ?? '', /上一组后来改用了其他版本.*建议重新生成/);
    assert.equal(fixture.episode().groups[0].staleNote, null, '第一组没有上一组');

    fixture.generation.selectResult({ resultId: firstDone.result.id });
    assert.equal(fixture.episode().groups[1].staleNote, null);
  } finally {
    fixture.database.close();
  }
});

test('保存尾帧：内容不合法或结果不存在时报错', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first] = fixture.groupIds();
    const { result } = await finishGroup(fixture, first);
    const frame = { resultId: result.id, mimeType: 'image/jpeg', width: 64, height: 36, data: FRAME_BASE64 };
    assert.throws(() => fixture.generation.saveTailFrame({ ...frame, mimeType: 'text/plain' }), ValidationError);
    assert.throws(() => fixture.generation.saveTailFrame({ ...frame, data: '' }), ValidationError);
    assert.throws(() => fixture.generation.saveTailFrame({ ...frame, resultId: 999 }), NotFoundError);
    assert.equal(fixture.jobs.findResultFrameId(result.id), undefined);
  } finally {
    fixture.database.close();
  }
});

test('截取尾帧失败：等待这个结果的任务失败并说明原因，通知界面；没有等待的任务时什么也不做', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    const { result } = await finishGroup(fixture, first);
    assert.deepEqual(fixture.generation.reportTailFrameFailure({ resultId: result.id, reason: '无法解码视频' }), { failed: 0 });

    await submitGroups(fixture, [second]);
    const [waiting] = fixture.jobs.listJobsByGroups([second]);
    fixture.changed.length = 0;
    assert.deepEqual(fixture.generation.reportTailFrameFailure({ resultId: result.id, reason: '无法解码视频' }), { failed: 1 });
    assert.deepEqual(fixture.changed, [{ jobId: waiting.id, groupId: second }]);
    const failed = fixture.episode().groups[1].jobs[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failure?.label, '无法截取上一组的尾帧');
    assert.equal(failed.failure?.message, '无法从上一组的视频截取尾帧：无法解码视频');
    assert.deepEqual(fixture.generation.reportTailFrameFailure({ resultId: 9999 }), { failed: 0 });
    assert.throws(() => fixture.generation.reportTailFrameFailure({}), ValidationError);
  } finally {
    fixture.database.close();
  }
});

/** 创建一个带一张参考图的场景资产，并把第一个镜头的首帧来源改为指定它；保存后分镜脚本回到待确认，需要重新确认。 */
function useAssetFirstFrame(fixture: Fixture): number {
  const assets = new AssetService(fixture.assetRepository);
  const asset = assets.createAsset('scene', {
    name: '灯塔远景',
    files: JSON.stringify([{ name: 'a.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64'), width: 64, height: 64 }])
  }, { fileSource: 'upload' });
  const first = fixture.storyboards.getView(fixture.work.id, fixture.episodeId).shots[0];
  fixture.storyboards.saveShot(fixture.run.id, {
    ref: first.id,
    ...first,
    firstFrameMode: 'asset',
    firstFrameAssetId: asset.id,
    entityIds: [...first.entityIds],
    sounds: []
  });
  fixture.approve();
  return asset.id;
}

test('指定图片作首帧：取资产的第一张参考图进快照、不传参考图，任务直接排队，预览与版本视图都说明首帧是指定图片', async () => {
  const fixture = await createFixture();
  try {
    const assetId = useAssetFirstFrame(fixture);
    const [groupId] = fixture.groupIds();
    const preview = await fixture.generation.previewSubmit({ workId: fixture.work.id, episodeId: fixture.episodeId, groupIds: [groupId], params: { modelId: fixture.modelId, ...PARAMS } });
    assert.deepEqual([preview.groups[0].firstFrame, preview.groups[0].blocking, preview.groups[0].referenceImageCount], ['image', [], 0]);

    const result = await submitGroups(fixture, [groupId]);
    assert.equal(result.rejected.length, 0);
    const [job] = fixture.jobs.listJobsByGroups([groupId]);
    assert.deepEqual([job.status, job.prevJobId, job.firstFrameId], ['queued', null, null]);
    assert.equal(job.snapshot.firstFrameFileId, fixture.assetRepository.listReferenceFiles(assetId)[0].id);
    assert.deepEqual([job.snapshot.referenceImageFileIds, job.snapshot.referenceAudioFileIds], [[], []]);
    const view = fixture.episode().groups[0].jobs[0];
    assert.deepEqual([view.usesFirstFrameImage, view.usesPreviousTail], [true, false]);
  } finally {
    fixture.database.close();
  }
});

test('指定图片作首帧：资产已被删除或没有参考图时拒绝并说明怎么办，模型不支持首帧输入时也拒绝', async () => {
  const fixture = await createFixture();
  const noFirstFrame = await createFixture({}, { ...FAKE_VIDEO_CAPABILITY, firstFrame: false });
  try {
    const assetId = useAssetFirstFrame(fixture);
    const [groupId] = fixture.groupIds();
    fixture.assetRepository.remove(assetId);
    const removed = await submitGroups(fixture, [groupId]);
    assert.equal(removed.submitted.length, 0);
    assert.match(removed.rejected[0].issues[0], /指定的资产已被删除.*首帧来源改为“无”/);
    assert.equal(fixture.jobs.listJobsByGroups([groupId]).length, 0);

    useAssetFirstFrame(noFirstFrame);
    const unsupported = await submitGroups(noFirstFrame, [noFirstFrame.groupIds()[0]]);
    assert.match(unsupported.rejected[0].issues[0], /不支持首帧输入.*指定图片/);
  } finally {
    fixture.database.close();
    noFirstFrame.database.close();
  }
});

test('提示词参数：负向清单与提示词改写按本组覆盖优先合并；预览带出完整提示词、负向清单与改写开关；不支持改写的模型被阻断；提示词带上分镜脚本的风格', async () => {
  const fixture = await createFixture({ visualStyle: '35mm 电影胶片' }, { ...FAKE_VIDEO_CAPABILITY, promptExtend: true });
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    const request = (params: Record<string, unknown>) => ({ workId: fixture.work.id, episodeId: fixture.episodeId, groupIds: [groupId], params: { modelId: fixture.modelId, ...PARAMS, ...params } });

    const plain = (await fixture.generation.previewSubmit(request({}))).groups[0];
    assert.deepEqual([plain.negativeList, plain.promptExtend], ['不要字幕，不要水印', null]);
    assert.ok(plain.prompt?.split('\n')[1] === '风格：35mm 电影胶片。', '提示词开头写分镜脚本的整体风格');

    const custom = (await fixture.generation.previewSubmit(request({ negativeList: '不要人脸变形', promptExtend: false }))).groups[0];
    assert.deepEqual([custom.negativeList, custom.promptExtend], ['不要人脸变形', false]);
    assert.ok(custom.prompt?.endsWith('负向清单：不要人脸变形。'));

    // 本组覆盖优先于本次提交携带的（本集、作品合并后的）值，空串覆盖表示这一组不要负向清单。
    saveGroupProfile(fixture, groupId, { negativeList: '', promptExtend: true });
    const overridden = (await fixture.generation.previewSubmit(request({ negativeList: '不要人脸变形', promptExtend: false }))).groups[0];
    assert.deepEqual([overridden.negativeList, overridden.promptExtend], [null, true]);
    assert.ok(!overridden.prompt?.includes('负向清单'));
    assert.deepEqual(fixture.episode().groups[0].overrides.negativeList, '');

    const result = await fixture.generation.submit(request({}));
    assert.equal(result.rejected.length, 0);
    const [job] = fixture.jobs.listJobsByGroups([groupId]);
    assert.deepEqual(job.snapshot.params.extraParams, { promptExtend: true });
    assert.equal(job.snapshot.params.negativeList ?? null, null);
  } finally {
    fixture.database.close();
  }

  const unsupported = await createFixture();
  try {
    unsupported.approve();
    const [groupId] = unsupported.groupIds();
    const preview = await unsupported.generation.previewSubmit({ workId: unsupported.work.id, episodeId: unsupported.episodeId, groupIds: [groupId], params: { modelId: unsupported.modelId, ...PARAMS, promptExtend: false } });
    assert.match(preview.groups[0].blocking.join(), /不支持提示词改写/);
    assert.equal(preview.groups[0].prompt, null);
    assert.equal((await unsupported.generation.getCatalog()).promptDefaults.negativeList, '不要字幕，不要水印');
  } finally {
    unsupported.database.close();
  }
});

test('预览提交：逐组汇总时长、首帧、参考素材与声音，阻断问题与提醒分开，不创建任务、不通知、不唤醒队列', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [groupId] = fixture.groupIds();
    const params = { modelId: fixture.modelId, ...PARAMS };
    const preview = await fixture.generation.previewSubmit({ workId: fixture.work.id, episodeId: fixture.episodeId, groupIds: [groupId], params });
    assert.equal(preview.groups.length, 1);
    const [group] = preview.groups;
    assert.deepEqual([group.groupId, group.seq, group.shotCount, group.totalSeconds, group.durationSeconds], [groupId, 1, 2, 8, 8]);
    assert.deepEqual([group.firstFrame, group.referenceImageCount, group.referenceAudioCount, group.audioMode], ['none', 0, 0, 'native']);
    assert.deepEqual(group.blocking, []);
    assert.ok(group.warnings.some((warning) => warning.includes('“守夜人”还没有绑定资产')));
    assert.equal(fixture.jobs.listJobsByGroups([groupId]).length, 0);
    assert.equal(fixture.pumps.length, 0);
    assert.deepEqual(fixture.changed, []);

    await submitGroups(fixture);
    const again = await fixture.generation.previewSubmit({ workId: fixture.work.id, episodeId: fixture.episodeId, groupIds: [groupId], params });
    assert.match(again.groups[0].blocking.join(), /正在生成/);
    assert.equal(again.groups[0].durationSeconds, null);
  } finally {
    fixture.database.close();
  }
});

test('预览提交：超过模型上限、参数不合法的组给出阻断问题；已有成功结果的组提醒会产生新版本', async () => {
  const fixture = await createFixture();
  try {
    setShotSeconds(fixture, fixture.episode().groups[0].shots[0].id, 8);
    fixture.approve();
    const base = { workId: fixture.work.id, episodeId: fixture.episodeId, groupIds: fixture.groupIds() };
    const tooLong = await fixture.generation.previewSubmit({ ...base, params: { modelId: fixture.modelId, ...PARAMS } });
    assert.match(tooLong.groups[0].blocking[0], /共 12 秒，超过所选模型单次最长 10 秒/);
    assert.equal(tooLong.groups[0].totalSeconds, 12);

    fixture.generation.splitGroup({ workId: fixture.work.id, episodeId: fixture.episodeId, shotId: fixture.episode().groups[0].shots[1].id });
    const groupIds = fixture.groupIds();
    const badResolution = await fixture.generation.previewSubmit({ ...base, groupIds, params: { modelId: fixture.modelId, ...PARAMS, resolution: '4K' } });
    assert.match(badResolution.groups[0].blocking.join(), /分辨率 4K/);
    assert.ok(badResolution.groups[1].blocking.length > 0, '第 2 组接在被拒绝的第 1 组之后，同样不能提交');
    assert.deepEqual(badResolution.groups.map((group) => group.seq), [1, 2], '按组序号排列');

    await assert.rejects(fixture.generation.previewSubmit({ ...base, groupIds, params: { modelId: 'x' } }), ValidationError);
  } finally {
    fixture.database.close();
  }
});

/** 保存一个镜头组的参数覆盖。 */
function saveGroupProfile(fixture: Fixture, groupId: number, changes: Record<string, unknown>) {
  return fixture.generation.saveGroupProfile({ workId: fixture.work.id, episodeId: fixture.episodeId, groupId, changes });
}

test('镜头组参数覆盖：保存、恢复继承、校验归属与模型，视图带出覆盖', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    assert.deepEqual(fixture.episode().groups[0].overrides, EMPTY_PROFILE);

    assert.deepEqual(saveGroupProfile(fixture, first, { resolution: '1080P', audioMode: 'none' }), { ...EMPTY_PROFILE, resolution: '1080P', audioMode: 'none' });
    saveGroupProfile(fixture, first, { audioMode: null });
    assert.deepEqual(fixture.episode().groups[0].overrides, { ...EMPTY_PROFILE, resolution: '1080P' });
    assert.equal(fixture.episode().groups[1].overrides.resolution, null, '只影响指定的组');
    assert.ok(second > first);

    assert.throws(() => saveGroupProfile(fixture, 99999, { resolution: '720P' }), ValidationError);
    assert.throws(() => saveGroupProfile(fixture, first, { modelId: 99999 }), (error) => error instanceof ValidationError && error.fieldErrors.modelId !== undefined);
    assert.throws(() => saveGroupProfile(fixture, first, {}), ValidationError);
    assert.throws(() => saveGroupProfile(fixture, first, { extraParams: {} }), ValidationError);
  } finally {
    fixture.database.close();
  }
});

test('镜头组参数覆盖：提交与预览按每组自己的参数编译，覆盖了模型的组按那个模型提交，模型不可用时只拒绝那一组', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' }, FAKE_VIDEO_CAPABILITY, true);
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    saveGroupProfile(fixture, first, { resolution: '1080P' });
    saveGroupProfile(fixture, second, { modelId: fixture.secondModelId, audioMode: 'none' });

    const preview = await fixture.generation.previewSubmit({
      workId: fixture.work.id,
      episodeId: fixture.episodeId,
      groupIds: [first, second],
      params: { modelId: fixture.modelId, ...PARAMS, audioMode: 'native' }
    });
    assert.deepEqual(preview.groups.map((group) => group.audioMode), ['native', 'none']);

    const result = await submitGroups(fixture, [first, second], { audioMode: 'native' });
    assert.equal(result.rejected.length, 0);
    const [firstJob] = fixture.jobs.listJobsByGroups([first]);
    const [secondJob] = fixture.jobs.listJobsByGroups([second]);
    assert.deepEqual([firstJob.modelId, firstJob.snapshot.params.resolution, firstJob.snapshot.params.audioMode], [fixture.modelId, '1080P', 'native']);
    assert.deepEqual([secondJob.modelId, secondJob.snapshot.params.resolution, secondJob.snapshot.params.audioMode], [fixture.secondModelId, '720P', 'none']);

  } finally {
    fixture.database.close();
  }

  const disabled = await createFixture({ groupMaxSeconds: '4' }, FAKE_VIDEO_CAPABILITY, true);
  try {
    disabled.approve();
    const [first, second] = disabled.groupIds();
    saveGroupProfile(disabled, second, { modelId: disabled.secondModelId });
    await disabled.providers.setModelEnabled({ modelId: disabled.secondModelId, isEnabled: false });
    const result = await submitGroups(disabled, [first, second]);
    assert.deepEqual(result.submitted.map((item) => item.groupId), [first], '只拒绝指定了不可用模型的那一组');
    assert.match(result.rejected[0].issues.join(), /这一组指定的视频模型不可用/);
  } finally {
    disabled.database.close();
  }
});

test('种子与声音内容：本次提交的值写入快照并出现在预览里；镜头组覆盖优先，版本视图能看到', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    saveGroupProfile(fixture, second, { seed: 9, audioElements: ['sfx'] });
    const params = { seed: 7, audioMode: 'native', audioElements: ['sfx', 'dialogue'] };
    const preview = await fixture.generation.previewSubmit({
      workId: fixture.work.id,
      episodeId: fixture.episodeId,
      groupIds: [first, second],
      params: { modelId: fixture.modelId, ...PARAMS, ...params }
    });
    assert.deepEqual(preview.groups.map((group) => [group.seed, group.audioElements]), [
      [7, ['dialogue', 'sfx']],
      [9, ['sfx']]
    ]);

    const result = await submitGroups(fixture, [first, second], params);
    assert.equal(result.rejected.length, 0);
    const [firstJob] = fixture.jobs.listJobsByGroups([first]);
    const [secondJob] = fixture.jobs.listJobsByGroups([second]);
    assert.deepEqual([firstJob.snapshot.params.seed, firstJob.snapshot.params.audioElements], [7, ['dialogue', 'sfx']]);
    assert.deepEqual([secondJob.snapshot.params.seed, secondJob.snapshot.params.audioElements], [9, ['sfx']]);
    const view = fixture.episode().groups[1].jobs[0];
    assert.deepEqual([view.params.seed, view.params.audioMode, view.params.audioElements], [9, 'native', ['sfx']]);
  } finally {
    fixture.database.close();
  }
});

test('生成时长：本组指定的时长按模型能力校验，小于镜头总时长、不在取值内或模型不支持种子时拒绝那一组', async () => {
  const fixture = await createFixture({ groupMaxSeconds: '4' });
  try {
    fixture.approve();
    const [first, second] = fixture.groupIds();
    const total = fixture.episode().groups[0].totalSeconds;
    saveGroupProfile(fixture, first, { durationSeconds: 10 });
    saveGroupProfile(fixture, second, { durationSeconds: 1 });
    const result = await submitGroups(fixture, [first, second]);
    assert.deepEqual(result.submitted.map((item) => item.groupId), [first]);
    assert.equal(fixture.jobs.listJobsByGroups([first])[0].snapshot.params.durationSeconds, 10, '直接采用指定的时长');
    assert.match(result.rejected[0].issues.join(), /小于这一组镜头的总时长/);
    assert.ok(total < 10);

    saveGroupProfile(fixture, second, { durationSeconds: 11 });
    assert.match((await submitGroups(fixture, [second])).rejected[0].issues.join(), /不在模型支持的取值内/);
    saveGroupProfile(fixture, second, { durationSeconds: null });
    assert.equal((await submitGroups(fixture, [second])).rejected.length, 0, '清除后按镜头总时长对齐');
  } finally {
    fixture.database.close();
  }

  const noSeed = await createFixture({ groupMaxSeconds: '4' }, { ...FAKE_VIDEO_CAPABILITY, seed: false });
  try {
    noSeed.approve();
    const [first] = noSeed.groupIds();
    assert.match((await submitGroups(noSeed, [first], { seed: 5 })).rejected[0].issues.join(), /不支持随机种子/);
    assert.equal((await submitGroups(noSeed, [first])).rejected.length, 0, '不设置种子照常提交');
  } finally {
    noSeed.database.close();
  }
});