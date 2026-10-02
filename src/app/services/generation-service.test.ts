// ------------------------------------------------------------------------
// 名称：generation-service.test.ts
// 说明：视频生成应用服务的自动化测试：工作台清单与视图、分镜脚本确认门槛、提交（编译、校验、入队、提醒）、重复提交、失败原因展示与再次生成、参考图绑定、取消与结果路径。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用真实的分镜脚本生成流程、内存数据库、假适配器和假调度器。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundError, ValidationError } from '../../domain/errors';
import { VideoGenerationRequest } from '../../domain/ports/provider-adapters';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { FAKE_VIDEO_CAPABILITY, FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { MemorySecretStore } from '../../domain/ports/testing/memory-secret-store';
import { normalizeWorkCreation } from '../../domain/rules/work-rules';
import { SqliteAssetRepository } from '../../infra/database/sqlite-asset-repository';
import { SqliteBindingRepository } from '../../infra/database/sqlite-binding-repository';
import { SqliteGenerationRepository } from '../../infra/database/sqlite-generation-repository';
import { SqliteProviderRepository } from '../../infra/database/sqlite-provider-repository';
import { SqliteScreenplayRepository } from '../../infra/database/sqlite-screenplay-repository';
import { SqliteStoryboardRepository } from '../../infra/database/sqlite-storyboard-repository';
import { JobChange } from '../queue/job-queue';
import { standardResponder } from '../stages/testing/scripted-text';
import { AssetService } from './asset-service';
import { BindingService } from './binding-service';
import { ChangeNotifier } from './change-notifier';
import { GenerationService } from './generation-service';
import { ProviderService } from './provider-service';
import { createServiceFixture } from './testing/service-fixture';

const CREATIVE_PARAMS = { chapterMinWords: 100, chapterMaxWords: 200, maxChapters: 3 };
const SCREENPLAY_PARAMS = { maxEpisodeDurationSeconds: '60', maxEpisodes: '3' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PARAMS = { aspectRatio: '16:9', resolution: '720P' };

/** 按能力严格检查分辨率的假适配器，用于验证被拒绝的镜头。 */
class StrictFakeProvider extends FakeVideoProvider {
  override validate(request: VideoGenerationRequest): readonly string[] {
    const issues = [...super.validate(request)];
    if (request.resolution !== null && !FAKE_VIDEO_CAPABILITY.resolutions.includes(request.resolution)) {
      issues.push(`分辨率 ${request.resolution} 不在模型支持的范围内。`);
    }
    return issues;
  }
}

/** 创建完整夹具：作品、已生成的分镜脚本（待确认）、服务与假依赖。 */
async function createFixture() {
  const fixture = createServiceFixture(standardResponder);
  const work = fixture.works.createWork(fixture.project.id, normalizeWorkCreation({ workName: '作品甲', kind: '单个短视频' }, 'text'));
  const creative = await fixture.stages.startCreative(work.id, CREATIVE_PARAMS);
  await fixture.runner.whenIdle();
  fixture.stages.approve(creative.id);
  const screenplay = await fixture.screenplays.start(work.id, SCREENPLAY_PARAMS);
  await fixture.runner.whenIdle();
  fixture.stages.approve(screenplay.id);
  const episodeId = fixture.storyboards.listEpisodeStatuses(work.id)[0].episodeId;
  const [run] = await fixture.storyboards.start(work.id, [episodeId], {});
  await fixture.runner.whenIdle();

  const { database } = fixture;
  const assetRepository = new SqliteAssetRepository(database);
  const providerRepository = new SqliteProviderRepository(database);
  const jobs = new SqliteGenerationRepository(database);
  const provider = new StrictFakeProvider();
  const secrets = new MemorySecretStore();
  const providers = new ProviderService({ repository: providerRepository, registry: new ProviderRegistry().register(provider), secrets });
  providers.syncCatalog();
  const [providerView] = await providers.listViews();
  await providers.setApiKey({ providerId: providerView.id, apiKey: 'sk-test' });
  const modelId = providerView.models[0].id;

  const pumps: number[] = [];
  const canceled: number[] = [];
  const changes = new ChangeNotifier<JobChange>();
  const changed: JobChange[] = [];
  changes.subscribe((change) => changed.push(change));
  const generation = new GenerationService({
    works: fixture.works,
    projects: fixture.projects,
    storyboardService: fixture.storyboards,
    runs: fixture.runs,
    screenplays: new SqliteScreenplayRepository(database),
    storyboards: new SqliteStoryboardRepository(database),
    bindings: new SqliteBindingRepository(database),
    assets: assetRepository,
    jobs,
    media: jobs,
    results: { save: async () => ({ filePath: 'x', sizeBytes: 1 }), resolvePath: (filePath) => `/store/${filePath}` },
    models: providerRepository,
    providers,
    scheduler: {
      pump: async () => {
        pumps.push(1);
      },
      cancel: async (jobId) => {
        canceled.push(jobId);
        return { remoteCanceled: false };
      }
    },
    changes
  });
  const approve = (): void => {
    fixture.stages.approve(run.id);
  };
  const shotIds = (): number[] => generation.getEpisode(work.id, episodeId).shots.map((shot) => shot.id);
  return { ...fixture, work, episodeId, run, generation, jobs, provider, providers, providerView, modelId, pumps, canceled, changed, assetRepository, approve, shotIds };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

/** 提交全部镜头。 */
function submitAll(fixture: Fixture, params: Record<string, unknown> = {}) {
  return fixture.generation.submit({
    workId: fixture.work.id,
    episodeId: fixture.episodeId,
    shotIds: fixture.shotIds(),
    params: { modelId: fixture.modelId, ...PARAMS, ...params }
  });
}

test('工作台清单：列出有分镜脚本的作品与集，以及可用的视频模型及其可选参数', async () => {
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
        audioModes: FAKE_VIDEO_CAPABILITY.audioModes
      }
    ]);

    await fixture.providers.clearApiKey({ providerId: fixture.providerView.id });
    assert.deepEqual((await fixture.generation.getCatalog()).models, [], '没有密钥就没有可用模型');
  } finally {
    fixture.database.close();
  }
});

test('分镜脚本未确认采用时不能生成，视图说明原因；确认后可以', async () => {
  const fixture = await createFixture();
  try {
    const before = fixture.generation.getEpisode(fixture.work.id, fixture.episodeId);
    assert.equal(before.canGenerate, false);
    assert.match(before.blockReason ?? '', /还没有确认采用/);
    assert.equal(before.shots.length, 2);
    await assert.rejects(submitAll(fixture), (error) => error instanceof ValidationError && /还没有确认采用/.test(error.message));

    fixture.approve();
    const after = fixture.generation.getEpisode(fixture.work.id, fixture.episodeId);
    assert.deepEqual([after.canGenerate, after.blockReason], [true, null]);
    assert.deepEqual(after.shots.map((shot) => [shot.seq, shot.entities.map((entity) => [entity.name, entity.bound])]), [
      [1, [['灯塔', false]]],
      [2, [['守夜人', false]]]
    ]);
  } finally {
    fixture.database.close();
  }
});

test('编辑已确认的镜头后分镜脚本回到待确认，需要重新确认才能再次生成', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const view = fixture.storyboards.getView(fixture.work.id, fixture.episodeId);
    const shot = view.shots[0];
    fixture.storyboards.saveShot(fixture.run.id, { ref: shot.id, ...shot, entityIds: [...shot.entityIds], sounds: [] });
    const blocked = fixture.generation.getEpisode(fixture.work.id, fixture.episodeId);
    assert.equal(blocked.canGenerate, false);
    assert.equal(blocked.shots.length, 2, '仍能看到镜头和历史任务');
    fixture.approve();
    assert.equal(fixture.generation.getEpisode(fixture.work.id, fixture.episodeId).canGenerate, true);
  } finally {
    fixture.database.close();
  }
});

test('提交：每个镜头生成一条排队中的任务，快照含提示词与参数，提醒随结果返回，并通知队列', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const result = await submitAll(fixture);
    assert.equal(result.rejected.length, 0);
    assert.deepEqual(result.submitted.map((item) => item.seq), [1, 2]);
    assert.equal(fixture.pumps.length, 1);
    assert.equal(fixture.changed.length, 2);

    const jobs = fixture.jobs.listJobsByShots(fixture.shotIds());
    assert.equal(jobs.length, 2);
    for (const job of jobs) {
      assert.deepEqual([job.status, job.attempt, job.modelId], ['queued', 1, fixture.modelId]);
      assert.deepEqual([job.snapshot.params.aspectRatio, job.snapshot.params.resolution, job.snapshot.params.audioMode], ['16:9', '720P', 'native']);
      assert.equal(job.snapshot.storyboardRunId, fixture.run.id);
    }
    const second = result.submitted.find((item) => item.seq === 2);
    assert.ok(second?.warnings.some((warning) => warning.includes('上一镜头尾帧作首帧')), '第 2 个镜头设置了尾帧衔接');
    assert.ok(second?.warnings.some((warning) => warning.includes('“守夜人”还没有绑定资产')));
    const snapshot = fixture.jobs.listJobsByShots([second?.shotId ?? 0])[0].snapshot;
    assert.ok(snapshot.prompt.includes('声音：'), '对白已编译进提示词');
  } finally {
    fixture.database.close();
  }
});

test('重复提交：镜头还有进行中的任务时被拒绝，其余镜头不受影响', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [first, second] = fixture.shotIds();
    await fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [first], params: { modelId: fixture.modelId, ...PARAMS } });
    const again = await submitAll(fixture);
    assert.deepEqual(again.submitted.map((item) => item.shotId), [second]);
    assert.deepEqual(again.rejected.map((item) => [item.shotId, item.issues[0]]), [[first, '这个镜头正在生成，完成或取消后才能再次提交。']]);
  } finally {
    fixture.database.close();
  }
});

test('校验不通过的镜头被拒绝并说明原因，不创建任务', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const result = await submitAll(fixture, { resolution: '4K' });
    assert.equal(result.submitted.length, 0);
    assert.equal(result.rejected.length, 2);
    assert.match(result.rejected[0].issues.join(), /分辨率 4K 不在模型支持的范围内/);
    assert.equal(fixture.jobs.listJobsByShots(fixture.shotIds()).length, 0);
    assert.equal(fixture.pumps.length, 0, '没有可提交的镜头时不唤醒队列');
  } finally {
    fixture.database.close();
  }
});

test('提交请求不合法：模型不可用、镜头不属于已确认的分镜脚本', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    await assert.rejects(submitAll(fixture, { modelId: 999 }), (error) => error instanceof ValidationError && 'modelId' in error.fieldErrors);
    await assert.rejects(fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [1], params: { modelId: 'x' } }), ValidationError);

    const result = await fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [9999], params: { modelId: fixture.modelId } });
    assert.deepEqual(result.rejected, [{ shotId: 9999, seq: 0, issues: ['镜头不属于当前已确认的分镜脚本。'] }]);
    await assert.rejects(fixture.generation.submit({ workId: 9999, episodeId: 1, shotIds: [1], params: { modelId: fixture.modelId } }), NotFoundError);
  } finally {
    fixture.database.close();
  }
});

test('失败原因：视图带分类名称、平台原文和处理建议；修改后可再次生成，历史都保留', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const [first] = fixture.shotIds();
    await fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [first], params: { modelId: fixture.modelId, ...PARAMS } });
    const [job] = fixture.jobs.listJobsByShots([first]);
    fixture.jobs.markFailed(job.id, { category: 'content_rejected', code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, 't');

    const view = fixture.generation.getEpisode(fixture.work.id, fixture.episodeId).shots[0];
    const failed = view.jobs[0];
    assert.deepEqual([failed.status, failed.statusLabel, failed.attempt], ['failed', '失败', 1]);
    assert.equal(failed.failure?.label, '内容审核未通过');
    assert.equal(failed.failure?.code, 'DataInspectionFailed');
    assert.equal(failed.failure?.message, 'Input data may contain inappropriate content.');
    assert.match(failed.failure?.hint ?? '', /编辑镜头/);
    assert.equal(failed.modelName, '假视频模型');

    // 用户修改镜头后再次生成：新任务，上一次的失败原因仍然可见。
    const again = await fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [first], params: { modelId: fixture.modelId, ...PARAMS } });
    assert.equal(again.submitted.length, 1);
    const history = fixture.generation.getEpisode(fixture.work.id, fixture.episodeId).shots[0].jobs;
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
    const [first] = fixture.shotIds();
    await fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [first], params: { modelId: fixture.modelId, ...PARAMS } });
    const [job] = fixture.jobs.listJobsByShots([first]);
    fixture.jobs.markSubmitted(job.id, 'r', 't');
    const saved = fixture.jobs.markSucceeded(job.id, { filePath: 'videos/1/1/1/1-1.mp4', remoteUrl: null, durationSeconds: 5, width: null, height: null, sizeBytes: 2048, hasAudio: true }, 't');

    const view = fixture.generation.getEpisode(fixture.work.id, fixture.episodeId).shots[0].jobs[0];
    assert.deepEqual(view.result, { id: saved?.id, durationSeconds: 5, sizeBytes: 2048, hasAudio: true, isSelected: true });
    assert.equal(fixture.generation.getResultPath({ resultId: saved?.id }), '/store/videos/1/1/1/1-1.mp4');
    assert.throws(() => fixture.generation.getResultPath({ resultId: 999 }), NotFoundError);
  } finally {
    fixture.database.close();
  }
});

test('绑定了形象资产的实体：参考图进入快照，并在提示词里说明图片编号', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const bindings = new BindingService(new SqliteBindingRepository(fixture.database), fixture.assetRepository);
    const assets = new AssetService(fixture.assetRepository, fixture.projects);
    const guard = fixture.storyboards.getView(fixture.work.id, fixture.episodeId).entities.find((entity) => entity.name === '守夜人');
    const asset = assets.createAsset('character', {
      projectName: '项目甲',
      name: '守夜人形象',
      files: JSON.stringify([{ name: 'a.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64'), width: 64, height: 64 }])
    });
    bindings.bind({ episodeId: fixture.episodeId, entityId: guard?.id, assetId: asset.id });

    const view = fixture.generation.getEpisode(fixture.work.id, fixture.episodeId);
    assert.deepEqual(view.shots[1].entities.map((entity) => [entity.name, entity.bound]), [['守夜人', true]]);

    const result = await submitAll(fixture);
    assert.equal(result.rejected.length, 0);
    const snapshot = fixture.jobs.listJobsByShots([view.shots[1].id])[0].snapshot;
    assert.equal(snapshot.referenceImageFileIds.length, 1);
    assert.ok(snapshot.prompt.startsWith('图1是角色“守夜人”的形象参考。'));
    assert.ok(!result.submitted.find((item) => item.seq === 2)?.warnings.some((warning) => warning.includes('还没有绑定资产')));
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
  } finally {
    fixture.database.close();
  }
});

test('订阅任务变化：提交时通知，取消订阅后不再通知', async () => {
  const fixture = await createFixture();
  try {
    fixture.approve();
    const received: number[] = [];
    const unsubscribe = fixture.generation.onDidChangeJobs((change) => received.push(change.jobId));
    const [first, second] = fixture.shotIds();
    await fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [first], params: { modelId: fixture.modelId, ...PARAMS } });
    unsubscribe();
    await fixture.generation.submit({ workId: fixture.work.id, episodeId: fixture.episodeId, shotIds: [second], params: { modelId: fixture.modelId, ...PARAMS } });
    assert.equal(received.length, 1);
  } finally {
    fixture.database.close();
  }
});
