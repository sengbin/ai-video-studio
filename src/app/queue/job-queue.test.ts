// ------------------------------------------------------------------------
// 名称：job-queue.test.ts
// 说明：视频生成队列的自动化测试：提交与轮询、成功保存结果、失败原因记录、并发上限、提交重试、取消、暂时性失败的容忍、重启恢复。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：使用内存数据库、假视频适配器、假结果存储和可调的时钟；直接调用 pump() 驱动。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderError } from '../../domain/errors';
import { JobSnapshot } from '../../domain/models/generation';
import { ResultStore } from '../../domain/ports/generation-repository';
import { ProviderCallContext, RemoteJobRef, RemoteJobState, VideoGenerationRequest, VideoJobResult } from '../../domain/ports/provider-adapters';
import { FAKE_CALL_CONTEXT, FakeVideoProvider } from '../../domain/ports/testing/fake-model-providers';
import { IN_MEMORY_DATABASE_PATH, openDatabase } from '../../infra/database/database-connection';
import { SqliteGenerationRepository } from '../../infra/database/sqlite-generation-repository';
import { seedGeneration } from '../../infra/database/testing/seed-generation';
import { JobChange, JobQueue } from './job-queue';

const SNAPSHOT: JobSnapshot = {
  storyboardRunId: 1,
  providerCode: 'fake',
  modelCode: 'fake-video',
  prompt: '提示词',
  params: { aspectRatio: '16:9', resolution: '720P', durationSeconds: 4, audioMode: 'native', seed: null, extraParams: {} },
  referenceImageFileIds: [],
  referenceAudioFileIds: [],
  warnings: []
};

const PLATFORM_REJECTION = 'Input data may contain inappropriate content.';

/** 提交与查询行为可脚本化的假适配器。 */
class ScriptedVideoProvider extends FakeVideoProvider {
  /** 每次提交前依次取出的错误；取完后正常提交。 */
  readonly submitErrors: Error[] = [];
  readonly canceled: RemoteJobRef[] = [];
  /** 下一次查询要抛出的错误。 */
  queryError: Error | null = null;
  supportsCancel = false;

  override async submit(request: VideoGenerationRequest): Promise<RemoteJobRef> {
    const error = this.submitErrors.shift();
    if (error !== undefined) throw error;
    return super.submit(request);
  }

  override async query(): Promise<RemoteJobState<VideoJobResult>> {
    if (this.queryError !== null) throw this.queryError;
    return super.query();
  }

  cancel(ref: RemoteJobRef, _context: ProviderCallContext): Promise<void> {
    if (!this.supportsCancel) return Promise.reject(new Error('不支持'));
    this.canceled.push(ref);
    return Promise.resolve();
  }
}

/** 创建队列与全部假依赖。 */
function createFixture(options: { maxConcurrent?: number; maxSubmitAttempts?: number; maxTransientFailures?: number; maxRunningMs?: number } = {}) {
  const database = openDatabase(IN_MEMORY_DATABASE_PATH);
  const seed = seedGeneration(database, 3);
  const jobs = new SqliteGenerationRepository(database);
  const provider = new ScriptedVideoProvider();
  const clock = { time: Date.parse('2026-10-02T08:00:00.000Z') };
  const changes: JobChange[] = [];
  const saved: string[] = [];
  const saveBehavior: { error: Error | null } = { error: null };
  const results: ResultStore = {
    save: async (_location, shotId, jobId, url) => {
      if (saveBehavior.error !== null) throw saveBehavior.error;
      saved.push(url);
      return { filePath: `videos/${shotId}-${jobId}.mp4`, sizeBytes: 1234 };
    },
    resolvePath: (filePath) => `/store/${filePath}`
  };
  const callBehavior: { error: Error | null } = { error: null };
  const queue = new JobQueue({
    jobs,
    media: jobs,
    calls: {
      resolveVideoCall: async () => {
        if (callBehavior.error !== null) throw callBehavior.error;
        return { adapter: provider, context: FAKE_CALL_CONTEXT, modelCode: 'fake-video' };
      }
    },
    results,
    notify: (change) => changes.push(change),
    now: () => new Date(clock.time),
    submitRetryDelayMs: 1000,
    ...options
  });
  const enqueue = (shotIndex = 0, snapshot: JobSnapshot = SNAPSHOT) =>
    jobs.insertJob({ shotId: seed.shotIds[shotIndex], modelId: seed.modelId, status: 'queued', snapshot, prevJobId: null }, new Date(clock.time).toISOString());
  return { database, seed, jobs, provider, clock, changes, saved, saveBehavior, callBehavior, queue, enqueue };
}

test('提交与完成：排队 → 生成中 → 成功，结果文件保存并自动采用，每次变化都通知', async () => {
  const { database, jobs, provider, changes, saved, queue, enqueue } = createFixture();
  try {
    const job = enqueue();
    await queue.pump();
    const running = jobs.findJob(job.id);
    assert.deepEqual([running?.status, running?.remoteJobId], ['running', 'fake-1']);
    assert.equal(provider.submitted[0].prompt, '提示词');
    assert.deepEqual([provider.submitted[0].resolution, provider.submitted[0].durationSeconds, provider.submitted[0].audioMode], ['720P', 4, 'native']);
    assert.deepEqual(saved, [], '提交那一轮不会查询');

    await queue.pump();
    const done = jobs.findJob(job.id);
    assert.equal(done?.status, 'succeeded');
    assert.deepEqual(saved, ['https://fake.example.com/video.mp4']);
    const [result] = jobs.listResultsByShots([job.shotId]);
    assert.deepEqual([result.filePath, result.sizeBytes, result.durationSeconds, result.hasAudio, result.isSelected], [`videos/${job.shotId}-${job.id}.mp4`, 1234, 5, true, true]);
    assert.deepEqual(changes, [{ jobId: job.id, shotId: job.shotId }, { jobId: job.id, shotId: job.shotId }]);
  } finally {
    database.close();
  }
});

test('生成失败：保存平台返回的分类、错误码和原文，可再次提交形成新任务', async () => {
  const { database, jobs, provider, queue, enqueue } = createFixture();
  try {
    const job = enqueue();
    provider.queryStates.push({ status: 'running', result: null, errorCategory: null, errorCode: null, errorMessage: null });
    provider.queryStates.push({ status: 'failed', result: null, errorCategory: 'content_rejected', errorCode: 'DataInspectionFailed', errorMessage: PLATFORM_REJECTION });
    await queue.pump();
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'running');
    await queue.pump();

    const failed = jobs.findJob(job.id);
    assert.equal(failed?.status, 'failed');
    assert.deepEqual(failed?.failure, { category: 'content_rejected', code: 'DataInspectionFailed', message: PLATFORM_REJECTION });
    assert.equal(jobs.hasActiveJob(job.shotId), false, '失败后镜头可以再次提交');

    const again = enqueue();
    assert.equal(again.attempt, 2);
    await queue.pump();
    assert.equal(jobs.findJob(again.id)?.status, 'running');
  } finally {
    database.close();
  }
});

test('生成失败：平台没有给原因时说明没有返回；任务已过期、已取消的状态也要处理', async () => {
  const { database, jobs, provider, queue, enqueue } = createFixture();
  try {
    const [a, b, c] = [enqueue(0), enqueue(1), enqueue(2)];
    await queue.pump();
    provider.queryStates.push({ status: 'failed', result: null, errorCategory: null, errorCode: null, errorMessage: null });
    provider.queryStates.push({ status: 'expired', result: null, errorCategory: null, errorCode: null, errorMessage: null });
    provider.queryStates.push({ status: 'canceled', result: null, errorCategory: null, errorCode: null, errorMessage: null });
    await queue.pump();
    assert.deepEqual(jobs.findJob(a.id)?.failure, { category: 'server', code: null, message: '平台没有返回失败原因。' });
    assert.match(jobs.findJob(b.id)?.failure?.message ?? '', /不再保留这个任务/);
    assert.equal(jobs.findJob(c.id)?.status, 'canceled');
  } finally {
    database.close();
  }
});

test('并发上限：生成中的任务达到上限后，其余保持排队，先提交的先处理', async () => {
  const { database, jobs, provider, queue, enqueue } = createFixture({ maxConcurrent: 2 });
  try {
    const [a, b, c] = [enqueue(0), enqueue(1), enqueue(2)];
    await queue.pump();
    assert.deepEqual([a, b, c].map((job) => jobs.findJob(job.id)?.status), ['running', 'running', 'queued']);
    assert.equal(provider.submitted.length, 2);
    await queue.pump();
    assert.deepEqual([a, b, c].map((job) => jobs.findJob(job.id)?.status), ['succeeded', 'succeeded', 'running'], '前两个完成后第三个才提交');
  } finally {
    database.close();
  }
});

test('提交失败：限流类自动重试，等待一段时间后再试；次数用完后记为失败并保留原因', async () => {
  const { database, jobs, provider, clock, queue, enqueue } = createFixture({ maxSubmitAttempts: 3 });
  try {
    const job = enqueue();
    provider.submitErrors.push(new ProviderError('rate_limited', '请求太频繁'), new ProviderError('rate_limited', '请求太频繁'), new ProviderError('rate_limited', '请求还是太频繁'));
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'queued');
    await queue.pump();
    assert.equal(provider.submitErrors.length, 2, '还没到重试时间，不会再次提交');

    clock.time += 1500;
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'queued');
    clock.time += 1500;
    await queue.pump();
    const failed = jobs.findJob(job.id);
    assert.equal(failed?.status, 'failed');
    assert.deepEqual(failed?.failure, { category: 'rate_limited', code: null, message: '请求还是太频繁' });
  } finally {
    database.close();
  }
});

test('提交失败：重试几次后成功则正常进入生成中', async () => {
  const { database, jobs, provider, clock, queue, enqueue } = createFixture();
  try {
    const job = enqueue();
    provider.submitErrors.push(new ProviderError('network', '连接失败'));
    await queue.pump();
    clock.time += 1500;
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'running');
  } finally {
    database.close();
  }
});

test('提交失败：鉴权、参数、内容审核类不重试，直接记为失败并保留错误码', async () => {
  const { database, jobs, provider, queue, enqueue } = createFixture();
  try {
    const job = enqueue();
    provider.submitErrors.push(new ProviderError('content_rejected', '内容不合规', { code: 'DataInspectionFailed' }));
    await queue.pump();
    assert.deepEqual(jobs.findJob(job.id)?.failure, { category: 'content_rejected', code: 'DataInspectionFailed', message: '内容不合规' });

    const other = enqueue(1);
    provider.submitErrors.push(new Error('程序错误'));
    await queue.pump();
    assert.deepEqual(jobs.findJob(other.id)?.failure, { category: 'server', code: null, message: '内部错误：程序错误' });
  } finally {
    database.close();
  }
});

test('无法提交：没有配置密钥、素材已被删除时直接记为失败', async () => {
  const { database, jobs, callBehavior, queue, enqueue } = createFixture();
  try {
    const noKey = enqueue(0);
    callBehavior.error = new ProviderError('auth', '尚未配置访问密钥');
    await queue.pump();
    assert.deepEqual(jobs.findJob(noKey.id)?.failure, { category: 'auth', code: null, message: '尚未配置访问密钥' });

    callBehavior.error = null;
    const missing = enqueue(1, { ...SNAPSHOT, referenceImageFileIds: [999] });
    await queue.pump();
    assert.equal(jobs.findJob(missing.id)?.failure?.category, 'invalid_request');
    assert.match(jobs.findJob(missing.id)?.failure?.message ?? '', /参考素材已被删除/);
  } finally {
    database.close();
  }
});

test('取消：排队中的任务直接取消；生成中的任务按服务商是否支持取消返回不同结果；已结束的不能取消', async () => {
  const { database, jobs, provider, queue, enqueue } = createFixture({ maxConcurrent: 1 });
  try {
    const [running, waiting] = [enqueue(0), enqueue(1)];
    await queue.pump();
    assert.equal(jobs.findJob(waiting.id)?.status, 'queued');
    assert.deepEqual(await queue.cancel(waiting.id), { remoteCanceled: false });
    assert.equal(jobs.findJob(waiting.id)?.status, 'canceled');

    assert.deepEqual(await queue.cancel(running.id), { remoteCanceled: false }, '服务商不支持取消，只停止本地跟踪');
    assert.equal(jobs.findJob(running.id)?.status, 'canceled');

    provider.supportsCancel = true;
    const third = enqueue(2);
    await queue.pump();
    assert.deepEqual(await queue.cancel(third.id), { remoteCanceled: true });
    assert.deepEqual(provider.canceled, [{ modelCode: 'fake-video', remoteJobId: 'fake-2' }]);

    await assert.rejects(queue.cancel(third.id), /不存在或已经结束/);
    await assert.rejects(queue.cancel(999), /不存在或已经结束/);
    await queue.pump();
    assert.equal(jobs.findJob(running.id)?.status, 'canceled', '已取消的任务不会被后续轮询改写');
  } finally {
    database.close();
  }
});

test('轮询出错：可重试的错误在容忍次数内等下一轮，成功后清零；超过次数记为失败', async () => {
  const { database, jobs, provider, queue, enqueue } = createFixture({ maxTransientFailures: 2 });
  try {
    const job = enqueue();
    await queue.pump();
    provider.queryError = new ProviderError('network', '网络断了');
    await queue.pump();
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'running');
    provider.queryError = null;
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'succeeded');

    const another = enqueue(1);
    await queue.pump();
    provider.queryError = new ProviderError('network', '网络断了');
    for (let round = 0; round < 3; round += 1) await queue.pump();
    assert.deepEqual(jobs.findJob(another.id)?.failure, { category: 'network', code: null, message: '网络断了' });
  } finally {
    database.close();
  }
});

test('轮询出错：鉴权类错误不容忍，立即记为失败', async () => {
  const { database, jobs, provider, queue, enqueue } = createFixture();
  try {
    const job = enqueue();
    await queue.pump();
    provider.queryError = new ProviderError('auth', '密钥失效');
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.failure?.category, 'auth');
  } finally {
    database.close();
  }
});

test('下载结果失败：在容忍次数内保持生成中，之后重试成功则完成；一直失败则记为失败并说明原因', async () => {
  const { database, jobs, saveBehavior, queue, enqueue } = createFixture({ maxTransientFailures: 1 });
  try {
    const job = enqueue();
    await queue.pump();
    saveBehavior.error = new Error('磁盘已满');
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'running');
    saveBehavior.error = null;
    await queue.pump();
    assert.equal(jobs.findJob(job.id)?.status, 'succeeded');

    const stuck = enqueue(1);
    await queue.pump();
    saveBehavior.error = new Error('磁盘已满');
    await queue.pump();
    await queue.pump();
    assert.match(jobs.findJob(stuck.id)?.failure?.message ?? '', /保存结果视频失败：磁盘已满/);
  } finally {
    database.close();
  }
});

test('等待超时：生成中的任务超过最长等待时间记为失败', async () => {
  const { database, jobs, clock, queue, enqueue } = createFixture({ maxRunningMs: 60_000 });
  try {
    const job = enqueue();
    await queue.pump();
    clock.time += 61_000;
    await queue.pump();
    assert.match(jobs.findJob(job.id)?.failure?.message ?? '', /超时/);
  } finally {
    database.close();
  }
});

test('重启恢复：没有远端标识的生成中任务记为失败，其余继续', async () => {
  const { database, jobs, queue, enqueue } = createFixture();
  try {
    const lost = enqueue(0);
    const resumed = enqueue(1);
    const queued = enqueue(2);
    database.prepare("UPDATE video_jobs SET status = 'running' WHERE id = ?").run(lost.id);
    database.prepare("UPDATE video_jobs SET status = 'running', remote_job_id = 'remote-x' WHERE id = ?").run(resumed.id);
    assert.equal(queue.recover(), 1);
    assert.deepEqual(jobs.findJob(lost.id)?.failure, { category: 'server', code: null, message: '扩展重启，已中断。' });
    assert.deepEqual([resumed, queued].map((job) => jobs.findJob(job.id)?.status), ['running', 'queued']);
  } finally {
    database.close();
  }
});

test('同时调用 pump：正在处理时只登记再来一轮，不重复提交', async () => {
  const { database, provider, queue, enqueue } = createFixture();
  try {
    enqueue();
    await Promise.all([queue.pump(), queue.pump(), queue.pump()]);
    assert.equal(provider.submitted.length, 1);
  } finally {
    database.close();
  }
});
