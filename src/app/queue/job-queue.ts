// ------------------------------------------------------------------------
// 名称：job-queue.ts
// 说明：视频生成队列：按并发上限把排队的任务提交给模型服务商，轮询生成中的任务，成功时下载结果，失败时记录平台返回的具体原因，支持取消与重启恢复。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；一轮处理由 pump() 完成，定时器由 start() 启动，测试直接调用 pump()。限流、服务端、网络类的提交失败自动重试，其余失败直接记为失败。等待前序的任务（上一组尾帧作首帧）在前序成功且尾帧入库后转为排队，前序失败或被取消时一并失败。
// ------------------------------------------------------------------------

import { NotFoundError, ProviderError } from '../../domain/errors';
import { JobFailure, VideoJobRecord } from '../../domain/models/generation';
import { GenerationRepository, JobMediaReader, ResultStore } from '../../domain/ports/generation-repository';
import { ResolvedVideoCall, VideoGenerationRequest } from '../../domain/ports/provider-adapters';
import { PREVIOUS_GROUP_UNAVAILABLE_CODE } from '../../domain/rules/generation-rules';
import { buildVideoRequest } from './video-request';

/** 同时处于生成中的任务数上限。 */
const DEFAULT_MAX_CONCURRENT = 3;
/** 可重试的提交失败最多尝试的次数。 */
const DEFAULT_MAX_SUBMIT_ATTEMPTS = 3;
/** 提交失败后再次尝试前的等待时间。 */
const DEFAULT_SUBMIT_RETRY_DELAY_MS = 15_000;
/** 轮询或下载连续出现暂时性失败的容忍次数。 */
const DEFAULT_MAX_TRANSIENT_FAILURES = 5;
/** 生成中的任务最长等待时间。 */
const DEFAULT_MAX_RUNNING_MS = 60 * 60 * 1000;

/** 启动恢复时无法继续的任务的失败原因。 */
const INTERRUPTED_MESSAGE = '扩展重启，已中断。';

/** 任务变化通知。 */
export interface JobChange {
  readonly jobId: number;
  readonly groupId: number;
  /** 为 true 时只要求界面刷新，不弹任务完成的通知（如切换采用的版本）。 */
  readonly quiet?: boolean;
}

/** 解析视频模型的调用凭据。 */
export interface VideoCallResolver {
  /** @throws ProviderError 模型不可用或没有配置密钥。 */
  resolveVideoCall(modelId: number): Promise<ResolvedVideoCall>;
}

/** 生成队列的依赖与可调参数。 */
export interface JobQueueDependencies {
  readonly jobs: GenerationRepository;
  readonly media: JobMediaReader;
  readonly calls: VideoCallResolver;
  readonly results: ResultStore;
  readonly notify: (change: JobChange) => void;
  /** 返回当前时间的函数，测试时可注入。 */
  readonly now?: () => Date;
  readonly maxConcurrent?: number;
  readonly maxSubmitAttempts?: number;
  readonly submitRetryDelayMs?: number;
  readonly maxTransientFailures?: number;
  readonly maxRunningMs?: number;
}

/** 视频生成队列。 */
export class JobQueue {
  private readonly now: () => Date;
  private readonly maxConcurrent: number;
  private readonly maxSubmitAttempts: number;
  private readonly submitRetryDelayMs: number;
  private readonly maxTransientFailures: number;
  private readonly maxRunningMs: number;
  /** 提交失败的次数与下次可尝试的时间。 */
  private readonly submitRetries = new Map<number, { count: number; nextAt: number }>();
  /** 轮询或下载连续失败的次数。 */
  private readonly transientFailures = new Map<number, number>();
  private pumping = false;
  private pumpAgain = false;

  constructor(private readonly dependencies: JobQueueDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.maxConcurrent = dependencies.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxSubmitAttempts = dependencies.maxSubmitAttempts ?? DEFAULT_MAX_SUBMIT_ATTEMPTS;
    this.submitRetryDelayMs = dependencies.submitRetryDelayMs ?? DEFAULT_SUBMIT_RETRY_DELAY_MS;
    this.maxTransientFailures = dependencies.maxTransientFailures ?? DEFAULT_MAX_TRANSIENT_FAILURES;
    this.maxRunningMs = dependencies.maxRunningMs ?? DEFAULT_MAX_RUNNING_MS;
  }

  /**
   * 扩展启动时调用：生成中但没有远端标识的任务无法继续查询，记为失败；有远端标识的继续轮询，排队中的继续提交。
   * @returns 被置为失败的任务数。
   */
  recover(): number {
    let failed = 0;
    for (const job of this.dependencies.jobs.listJobsByStatus(['running'])) {
      if (job.remoteJobId === null && this.fail(job, { category: 'server', code: null, message: INTERRUPTED_MESSAGE })) {
        failed += 1;
      }
    }
    return failed;
  }

  /**
   * 启动定时处理：立即处理一轮，之后每隔 intervalMs 处理一轮。
   * @returns 停止定时处理的函数。
   */
  start(intervalMs: number): () => void {
    const run = (): void => {
      this.pump().catch((error: unknown) => console.error('处理生成队列时出现未预期的错误：', error));
    };
    run();
    const timer = setInterval(run, intervalMs);
    return () => clearInterval(timer);
  }

  /**
   * 处理一轮：先轮询生成中的任务，再处理等待前序的任务，最后提交排队中的任务。正在处理时只登记再来一轮，不并发处理。
   */
  async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        await this.pollRunning();
        this.releaseWaiting();
        await this.submitQueued();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  /**
   * 取消进行中的任务：生成中的任务若服务商支持取消则同时取消远端任务；不支持时只停止本地跟踪，远端任务可能仍会继续并计费。
   * @returns remoteCanceled 为 true 表示已通知服务商取消。
   * @throws NotFoundError 任务不存在，或已经结束。
   */
  async cancel(jobId: number): Promise<{ readonly remoteCanceled: boolean }> {
    const { jobs, calls } = this.dependencies;
    const job = jobs.findJob(jobId);
    if (job === undefined || (job.status !== 'waiting' && job.status !== 'queued' && job.status !== 'running')) {
      throw new NotFoundError('任务不存在或已经结束。');
    }
    let remoteCanceled = false;
    if (job.status === 'running' && job.remoteJobId !== null) {
      try {
        const call = await calls.resolveVideoCall(job.modelId);
        if (call.adapter.cancel !== undefined) {
          await call.adapter.cancel({ modelCode: call.modelCode, remoteJobId: job.remoteJobId }, call.context);
          remoteCanceled = true;
        }
      } catch {
        // 通知服务商取消失败不影响本地取消。
      }
    }
    if (jobs.markCanceled(jobId, this.timestamp())) {
      this.forget(jobId);
      this.dependencies.notify({ jobId, groupId: job.groupId });
    }
    return { remoteCanceled };
  }

  /** 轮询全部生成中的任务。 */
  private async pollRunning(): Promise<void> {
    for (const job of this.dependencies.jobs.listJobsByStatus(['running'])) {
      await this.pollOne(job);
    }
  }

  /** 处理等待前序的任务：前序成功且尾帧已入库则转为排队；前序仍在进行或尾帧还没截取则继续等；前序失败、被取消或已不存在则这些任务一并失败。 */
  private releaseWaiting(): void {
    const { jobs, notify } = this.dependencies;
    for (const job of jobs.listJobsByStatus(['waiting'])) {
      const previous = job.prevJobId === null ? undefined : jobs.findJob(job.prevJobId);
      if (previous !== undefined && (previous.status === 'waiting' || previous.status === 'queued' || previous.status === 'running')) {
        continue;
      }
      const result = previous !== undefined && previous.status === 'succeeded' ? jobs.findResultByJob(previous.id) : undefined;
      if (previous === undefined || previous.status !== 'succeeded' || result === undefined) {
        this.fail(job, { category: 'invalid_request', code: PREVIOUS_GROUP_UNAVAILABLE_CODE, message: '上一组的任务失败、被取消或已不存在，没有可用的尾帧。' });
        continue;
      }
      const frameId = jobs.findResultFrameId(result.id);
      if (frameId !== undefined && jobs.releaseWaitingJob(job.id, frameId)) {
        notify({ jobId: job.id, groupId: job.groupId });
      }
    }
  }

  /** 在并发上限内提交排队中的任务，先提交的先处理。 */
  private async submitQueued(): Promise<void> {
    const { jobs } = this.dependencies;
    let running = jobs.listJobsByStatus(['running']).length;
    for (const job of jobs.listJobsByStatus(['queued'])) {
      if (running >= this.maxConcurrent) {
        return;
      }
      const retry = this.submitRetries.get(job.id);
      if (retry !== undefined && retry.nextAt > this.now().getTime()) {
        continue;
      }
      if (await this.submitOne(job)) {
        running += 1;
      }
    }
  }

  /** 提交一个任务；成功变为生成中并返回 true，可重试的失败保持排队，其他失败记为失败。 */
  private async submitOne(job: VideoJobRecord): Promise<boolean> {
    let call: ResolvedVideoCall;
    let request: VideoGenerationRequest;
    try {
      call = await this.dependencies.calls.resolveVideoCall(job.modelId);
      request = buildVideoRequest(job.snapshot, job.firstFrameId, this.dependencies.media, call.modelCode);
      const issues = call.adapter.validate(request);
      if (issues.length > 0) {
        throw new ProviderError('invalid_request', issues.join('；'));
      }
    } catch (error) {
      this.fail(job, toFailure(error));
      return false;
    }

    try {
      const ref = await call.adapter.submit(request, call.context);
      if (this.dependencies.jobs.markSubmitted(job.id, ref.remoteJobId, this.timestamp())) {
        this.submitRetries.delete(job.id);
        this.dependencies.notify({ jobId: job.id, groupId: job.groupId });
      }
      return true;
    } catch (error) {
      const attempts = (this.submitRetries.get(job.id)?.count ?? 0) + 1;
      if (error instanceof ProviderError && error.retryable && attempts < this.maxSubmitAttempts) {
        this.submitRetries.set(job.id, { count: attempts, nextAt: this.now().getTime() + this.submitRetryDelayMs });
        return false;
      }
      this.fail(job, toFailure(error));
      return false;
    }
  }

  /** 查询一个生成中的任务并处理结果。 */
  private async pollOne(job: VideoJobRecord): Promise<void> {
    if (job.remoteJobId === null) {
      this.fail(job, { category: 'server', code: null, message: INTERRUPTED_MESSAGE });
      return;
    }
    // 超时也要先查询：扩展关闭期间平台可能已经生成完，只有查询后仍未结束才记为超时。
    const timedOut = job.submittedAt !== null && this.now().getTime() - Date.parse(job.submittedAt) > this.maxRunningMs;

    try {
      const call = await this.dependencies.calls.resolveVideoCall(job.modelId);
      const state = await call.adapter.query({ modelCode: call.modelCode, remoteJobId: job.remoteJobId }, call.context);
      // 查询成功即清零；结果下载失败的次数要跨轮累计，所以成功态不在此清零
      if (state.status !== 'succeeded') this.transientFailures.delete(job.id);
      switch (state.status) {
        case 'succeeded':
          if (state.result !== null) await this.saveResult(job, state.result.videoUrl, state.result.durationSeconds);
          return;
        case 'failed':
          this.fail(job, {
            category: state.errorCategory ?? 'server',
            code: state.errorCode,
            message: state.errorMessage ?? '平台没有返回失败原因。'
          });
          return;
        case 'canceled':
          if (this.dependencies.jobs.markCanceled(job.id, this.timestamp())) this.dependencies.notify({ jobId: job.id, groupId: job.groupId });
          return;
        case 'expired':
          this.fail(job, { category: 'server', code: null, message: '平台已不再保留这个任务（通常保留 24 小时），请重新生成。' });
          return;
        default:
          if (timedOut) this.fail(job, { category: 'server', code: null, message: '等待生成结果超时，请重新生成。' });
          return;
      }
    } catch (error) {
      this.handleTransient(job, error);
    }
  }

  /** 下载结果视频并保存；下载失败按暂时性失败处理。 */
  private async saveResult(job: VideoJobRecord, videoUrl: string, durationSeconds: number | null): Promise<void> {
    const { jobs, results } = this.dependencies;
    const location = jobs.getGroupLocation(job.groupId);
    if (location === undefined) {
      return;
    }
    try {
      const saved = await results.save(location, job.groupId, job.id, videoUrl);
      const result = jobs.markSucceeded(
        job.id,
        { filePath: saved.filePath, remoteUrl: null, durationSeconds, width: null, height: null, sizeBytes: saved.sizeBytes, hasAudio: job.snapshot.params.audioMode === 'native' },
        this.timestamp()
      );
      if (result !== undefined) {
        this.forget(job.id);
        this.dependencies.notify({ jobId: job.id, groupId: job.groupId });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleTransient(job, new ProviderError('network', `保存结果视频失败：${detail}`, { cause: error }));
    }
  }

  /** 轮询或下载出错：可重试的分类在容忍次数内等下一轮，否则记为失败。 */
  private handleTransient(job: VideoJobRecord, error: unknown): void {
    const failures = (this.transientFailures.get(job.id) ?? 0) + 1;
    if (error instanceof ProviderError && error.retryable && failures <= this.maxTransientFailures) {
      this.transientFailures.set(job.id, failures);
      return;
    }
    this.fail(job, toFailure(error));
  }

  /** 把任务记为失败并通知；返回是否真正写入（任务已被取消或结束时不覆盖）。 */
  private fail(job: VideoJobRecord, failure: JobFailure): boolean {
    const written = this.dependencies.jobs.markFailed(job.id, failure, this.timestamp());
    this.forget(job.id);
    if (written) {
      this.dependencies.notify({ jobId: job.id, groupId: job.groupId });
    }
    return written;
  }

  private forget(jobId: number): void {
    this.submitRetries.delete(jobId);
    this.transientFailures.delete(jobId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** 把任意错误转换为任务失败原因：服务商错误保留分类与错误码，其他错误按服务端错误记录。 */
function toFailure(error: unknown): JobFailure {
  if (error instanceof ProviderError) {
    return { category: error.category, code: error.code, message: error.message };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { category: 'server', code: null, message: `内部错误：${detail}` };
}
