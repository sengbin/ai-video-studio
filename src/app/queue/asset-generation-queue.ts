// ------------------------------------------------------------------------
// 名称：asset-generation-queue.ts
// 说明：资产生成队列：按并发上限把排队的版本提交给图像、音频模型，轮询生成中的版本，成功时下载结果文件，失败时记录平台返回的具体原因，支持取消与重启恢复。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；一轮处理由 pump() 完成，定时器由 start() 启动（返回的停止函数会等正在进行的一轮处理结束，停止后不再开始新的一轮），测试直接调用 pump()。写法与视频队列一致：限流、服务端、网络类的提交失败自动重试，其余失败直接记为失败；千问音频接口是同步的，提交后第一次轮询即成功。
// ------------------------------------------------------------------------

import { NotFoundError, ProviderError } from '../../domain/errors';
import { AssetRecord } from '../../domain/models/asset';
import { AssetVersionFailure, AssetVersionRecord, NewAssetVersionFile } from '../../domain/models/asset-version';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { AssetVersionRepository } from '../../domain/ports/asset-version-repository';
import { MediaDownloader } from '../../domain/ports/media-downloader';
import {
  AudioGenerationRequest,
  ImageGenerationRequest,
  MediaInput,
  ResolvedAudioCall,
  ResolvedImageCall
} from '../../domain/ports/provider-adapters';
import { readAudioKind } from '../../domain/rules/asset-prompt-rules';
import { ASSET_AUDIO_MAX_BYTES, detectAudioMime } from '../../domain/rules/asset-rules';
import { detectImageMime } from '../../domain/rules/work-rules';

/** 同时处于生成中的版本数上限。 */
const DEFAULT_MAX_CONCURRENT = 3;
/** 可重试的提交失败最多尝试的次数。 */
const DEFAULT_MAX_SUBMIT_ATTEMPTS = 3;
/** 提交失败后再次尝试前的等待时间。 */
const DEFAULT_SUBMIT_RETRY_DELAY_MS = 15_000;
/** 轮询或下载连续出现暂时性失败的容忍次数。 */
const DEFAULT_MAX_TRANSIENT_FAILURES = 5;
/** 生成中的版本最长等待时间。 */
const DEFAULT_MAX_RUNNING_MS = 30 * 60 * 1000;
/** 单张结果图片的大小上限。 */
const IMAGE_RESULT_MAX_BYTES = 30 * 1024 * 1024;

const INTERRUPTED_MESSAGE = '扩展重启，已中断。';

/** 版本变化通知。 */
export interface AssetVersionChange {
  readonly assetId: number;
  readonly versionId: number;
}

/** 取消版本的结果。 */
export interface AssetVersionCancelResult {
  /** 为 true 表示已通知服务商取消。 */
  readonly remoteCanceled: boolean;
  /** 通知服务商取消失败的原因；没有失败时缺省。此时本地取消仍然成功，但平台上的任务可能仍在继续并计费。 */
  readonly remoteCancelError?: string;
}

/** 解析图像、音频模型的调用凭据。 */
export interface AssetCallResolver {
  /** @throws ProviderError 模型不可用或没有配置密钥。 */
  resolveImageCall(modelId: number): Promise<ResolvedImageCall>;
  resolveAudioCall(modelId: number): Promise<ResolvedAudioCall>;
}

/** 资产生成队列的依赖与可调参数。 */
export interface AssetGenerationQueueDependencies {
  readonly versions: AssetVersionRepository;
  readonly assets: AssetRepository;
  readonly calls: AssetCallResolver;
  readonly downloader: MediaDownloader;
  readonly notify: (change: AssetVersionChange) => void;
  readonly now?: () => Date;
  readonly maxConcurrent?: number;
  readonly maxSubmitAttempts?: number;
  readonly submitRetryDelayMs?: number;
  readonly maxTransientFailures?: number;
  readonly maxRunningMs?: number;
}

/** 资产生成队列。 */
export class AssetGenerationQueue {
  private readonly now: () => Date;
  private readonly maxConcurrent: number;
  private readonly maxSubmitAttempts: number;
  private readonly submitRetryDelayMs: number;
  private readonly maxTransientFailures: number;
  private readonly maxRunningMs: number;
  private readonly submitRetries = new Map<number, { count: number; nextAt: number }>();
  private readonly transientFailures = new Map<number, number>();
  private pumping = false;
  private pumpAgain = false;
  /** 正在进行的一轮处理，停止定时处理时据此等待它结束。 */
  private activePump: Promise<void> | undefined;
  /** 已停止：为 true 时不再开始新的一轮处理，进行中的一轮在处理完当前版本后结束。 */
  private stopped = false;

  constructor(private readonly dependencies: AssetGenerationQueueDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.maxConcurrent = dependencies.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.maxSubmitAttempts = dependencies.maxSubmitAttempts ?? DEFAULT_MAX_SUBMIT_ATTEMPTS;
    this.submitRetryDelayMs = dependencies.submitRetryDelayMs ?? DEFAULT_SUBMIT_RETRY_DELAY_MS;
    this.maxTransientFailures = dependencies.maxTransientFailures ?? DEFAULT_MAX_TRANSIENT_FAILURES;
    this.maxRunningMs = dependencies.maxRunningMs ?? DEFAULT_MAX_RUNNING_MS;
  }

  /** 扩展启动时调用：生成中但没有远端标识的版本无法继续查询，记为失败；其余继续。返回置为失败的数量。 */
  recover(): number {
    let failed = 0;
    for (const version of this.dependencies.versions.listByStatus(['running'])) {
      if (version.remoteJobId === null && this.fail(version, { category: 'server', code: null, message: INTERRUPTED_MESSAGE })) {
        failed += 1;
      }
    }
    return failed;
  }

  /**
   * 启动定时处理：立即处理一轮，之后每隔 intervalMs 处理一轮。
   * @returns 停止函数：停止定时器、不再开始新的一轮处理，并等待正在进行的一轮处理结束。
   */
  start(intervalMs: number): () => Promise<void> {
    this.stopped = false;
    const run = (): void => {
      this.pump().catch((error: unknown) => console.error('处理资产生成队列时出现未预期的错误：', error));
    };
    run();
    const timer = setInterval(run, intervalMs);
    return async () => {
      this.stopped = true;
      clearInterval(timer);
      // 进行中的一轮出错时已由发起方记录日志，这里只等它结束。
      await this.activePump?.then(undefined, () => undefined);
    };
  }

  /** 处理一轮：先轮询生成中的版本，再提交排队中的版本。正在处理时只登记再来一轮；已停止时什么也不做。 */
  async pump(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    const round = this.runRounds();
    this.activePump = round;
    try {
      await round;
    } finally {
      this.pumping = false;
      this.activePump = undefined;
    }
  }

  /** 连续处理，直到没有人登记再来一轮或队列已停止。 */
  private async runRounds(): Promise<void> {
    do {
      this.pumpAgain = false;
      for (const version of this.dependencies.versions.listByStatus(['running'])) {
        if (this.stopped) return;
        await this.pollOne(version);
      }
      await this.submitQueued();
    } while (this.pumpAgain && !this.stopped);
  }

  /**
   * 取消进行中的版本：服务商支持取消时同时取消远端任务，不支持时只停止本地跟踪（远端可能继续并计费）；通知服务商失败时本地取消仍然成功，失败原因放在 remoteCancelError 里。
   * @throws NotFoundError 版本不存在或已经结束。
   */
  async cancel(versionId: number): Promise<AssetVersionCancelResult> {
    const { versions } = this.dependencies;
    const version = versions.findVersion(versionId);
    if (version === undefined || (version.status !== 'queued' && version.status !== 'running')) {
      throw new NotFoundError('版本不存在或已经结束。');
    }
    let remoteCanceled = false;
    let remoteCancelError: string | undefined;
    if (version.status === 'running' && version.remoteJobId !== null) {
      try {
        const call = await this.resolveCall(version);
        if (call.adapter.cancel !== undefined) {
          await call.adapter.cancel({ modelCode: call.modelCode, remoteJobId: version.remoteJobId }, call.context);
          remoteCanceled = true;
        }
      } catch (error) {
        // 通知服务商取消失败不影响本地取消，但要把原因带给调用方，让用户知道平台上的任务可能仍在计费。
        remoteCancelError = error instanceof Error ? error.message : String(error);
      }
    }
    if (versions.markCanceled(versionId, this.timestamp())) {
      this.forget(versionId);
      this.dependencies.notify({ assetId: version.assetId, versionId });
    }
    return remoteCancelError === undefined ? { remoteCanceled } : { remoteCanceled, remoteCancelError };
  }

  private async submitQueued(): Promise<void> {
    const { versions } = this.dependencies;
    let running = versions.listByStatus(['running']).length;
    for (const version of versions.listByStatus(['queued'])) {
      if (running >= this.maxConcurrent || this.stopped) {
        return;
      }
      const retry = this.submitRetries.get(version.id);
      if (retry !== undefined && retry.nextAt > this.now().getTime()) {
        continue;
      }
      if (await this.submitOne(version)) {
        running += 1;
      }
    }
  }

  /** 提交一个版本；成功变为生成中并返回 true，可重试的失败保持排队，其他失败记为失败。 */
  private async submitOne(version: AssetVersionRecord): Promise<boolean> {
    const { assets, versions } = this.dependencies;
    let submit: () => Promise<{ remoteJobId: string }>;
    try {
      const asset = assets.findById(version.assetId);
      if (asset === undefined) {
        throw new ProviderError('invalid_request', '资产已被删除。');
      }
      submit = await this.prepare(version, asset);
    } catch (error) {
      this.fail(version, toFailure(error));
      return false;
    }
    try {
      const ref = await submit();
      if (versions.markSubmitted(version.id, ref.remoteJobId, this.timestamp())) {
        this.submitRetries.delete(version.id);
        this.dependencies.notify({ assetId: version.assetId, versionId: version.id });
      }
      return true;
    } catch (error) {
      const attempts = (this.submitRetries.get(version.id)?.count ?? 0) + 1;
      if (error instanceof ProviderError && error.retryable && attempts < this.maxSubmitAttempts) {
        this.submitRetries.set(version.id, { count: attempts, nextAt: this.now().getTime() + this.submitRetryDelayMs });
        return false;
      }
      this.fail(version, toFailure(error));
      return false;
    }
  }

  /** 解析模型、构造并校验请求，返回真正发起提交的函数；校验失败抛出参数错误。 */
  private async prepare(version: AssetVersionRecord, asset: AssetRecord): Promise<() => Promise<{ remoteJobId: string }>> {
    if (asset.kind === 'audio') {
      const call = await this.dependencies.calls.resolveAudioCall(version.modelId);
      const request = buildAudioRequest(version, asset, call.modelCode);
      assertValid(call.adapter.validate(request));
      return () => call.adapter.submit(request, call.context);
    }
    const call = await this.dependencies.calls.resolveImageCall(version.modelId);
    const request = buildImageRequest(version, this.dependencies.assets.listReferenceFiles(asset.id), call.modelCode);
    assertValid(call.adapter.validate(request));
    return () => call.adapter.submit(request, call.context);
  }

  private async resolveCall(version: AssetVersionRecord): Promise<ResolvedImageCall | ResolvedAudioCall> {
    const asset = this.dependencies.assets.findById(version.assetId);
    return asset?.kind === 'audio' ? this.dependencies.calls.resolveAudioCall(version.modelId) : this.dependencies.calls.resolveImageCall(version.modelId);
  }

  /** 查询一个生成中的版本并处理结果。 */
  private async pollOne(version: AssetVersionRecord): Promise<void> {
    if (version.remoteJobId === null) {
      this.fail(version, { category: 'server', code: null, message: INTERRUPTED_MESSAGE });
      return;
    }
    if (version.submittedAt !== null && this.now().getTime() - Date.parse(version.submittedAt) > this.maxRunningMs) {
      this.fail(version, { category: 'server', code: null, message: '等待生成结果超时，请重新生成。' });
      return;
    }
    try {
      const call = await this.resolveCall(version);
      const ref = { modelCode: call.modelCode, remoteJobId: version.remoteJobId };
      const asset = this.dependencies.assets.findById(version.assetId);
      const state =
        asset?.kind === 'audio'
          ? await (call as ResolvedAudioCall).adapter.query(ref, call.context)
          : await (call as ResolvedImageCall).adapter.query(ref, call.context);
      if (state.status !== 'succeeded') this.transientFailures.delete(version.id);
      switch (state.status) {
        case 'succeeded':
          if (state.result === null) {
            this.fail(version, { category: 'server', code: null, message: '平台报告任务已完成，但没有返回结果文件，请重新生成。' });
          } else {
            await this.saveResult(version, asset, state.result);
          }
          return;
        case 'failed':
          this.fail(version, {
            category: state.errorCategory ?? 'server',
            code: state.errorCode,
            message: state.errorMessage ?? '平台没有返回失败原因。'
          });
          return;
        case 'canceled':
          if (this.dependencies.versions.markCanceled(version.id, this.timestamp())) {
            this.dependencies.notify({ assetId: version.assetId, versionId: version.id });
          }
          return;
        case 'expired':
          this.fail(version, { category: 'server', code: null, message: '平台已不再保留这个任务，请重新生成。' });
          return;
        default:
          return;
      }
    } catch (error) {
      this.handleTransient(version, error);
    }
  }

  /** 下载结果并保存为版本文件；下载失败按暂时性失败处理，文件格式不对直接失败。 */
  private async saveResult(
    version: AssetVersionRecord,
    asset: AssetRecord | undefined,
    result: { readonly imageUrls: readonly string[] } | { readonly audioUrl: string; readonly durationSeconds: number | null }
  ): Promise<void> {
    const { downloader, versions } = this.dependencies;
    try {
      const files: NewAssetVersionFile[] = [];
      if ('imageUrls' in result) {
        for (const [index, url] of result.imageUrls.entries()) {
          const content = await downloader.download(url, IMAGE_RESULT_MAX_BYTES);
          const mime = detectImageMime(content);
          if (mime === null) {
            this.fail(version, { category: 'server', code: null, message: '平台返回的文件不是有效的 PNG、JPEG 或 WebP 图片。' });
            return;
          }
          files.push({ role: 'result', fileName: `v${version.version}-${index + 1}${extensionOf(mime)}`, mime, width: null, height: null, durationSeconds: null, content, sortOrder: index });
        }
      } else {
        const content = await downloader.download(result.audioUrl, ASSET_AUDIO_MAX_BYTES);
        const mime = detectAudioMime(content);
        if (mime === null) {
          this.fail(version, { category: 'server', code: null, message: '平台返回的文件不是有效的 MP3、WAV 或 M4A 音频。' });
          return;
        }
        files.push({ role: 'result', fileName: `v${version.version}${extensionOf(mime)}`, mime, width: null, height: null, durationSeconds: result.durationSeconds, content, sortOrder: 0 });
      }
      if (files.length === 0) {
        this.fail(version, { category: 'server', code: null, message: '平台没有返回任何结果文件。' });
        return;
      }
      if (versions.markSucceeded(version.id, files, this.timestamp())) {
        this.forget(version.id);
        this.dependencies.notify({ assetId: asset?.id ?? version.assetId, versionId: version.id });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.handleTransient(version, new ProviderError('network', `保存结果文件失败：${detail}`, { cause: error }));
    }
  }

  private handleTransient(version: AssetVersionRecord, error: unknown): void {
    const failures = (this.transientFailures.get(version.id) ?? 0) + 1;
    if (error instanceof ProviderError && error.retryable && failures <= this.maxTransientFailures) {
      this.transientFailures.set(version.id, failures);
      return;
    }
    this.fail(version, toFailure(error));
  }

  /** 记为失败并通知；返回是否真正写入（已被取消或结束的不覆盖）。 */
  private fail(version: AssetVersionRecord, failure: AssetVersionFailure): boolean {
    const written = this.dependencies.versions.markFailed(version.id, failure, this.timestamp());
    this.forget(version.id);
    if (written) {
      this.dependencies.notify({ assetId: version.assetId, versionId: version.id });
    }
    return written;
  }

  private forget(versionId: number): void {
    this.submitRetries.delete(versionId);
    this.transientFailures.delete(versionId);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** 构造图像生成请求：按快照里选择的语言取提示词，参考图取资产现有的前几张。 */
function buildImageRequest(
  version: AssetVersionRecord,
  referenceFiles: ReadonlyArray<{ readonly mime: string; readonly content: Buffer }>,
  modelCode: string
): ImageGenerationRequest {
  const { snapshot } = version;
  const references: MediaInput[] = snapshot.params.useReferenceImages
    ? referenceFiles.slice(0, snapshot.referenceCount).map((file) => ({ mimeType: file.mime, data: file.content }))
    : [];
  return {
    modelCode,
    prompt: snapshot.promptLanguage === 'zh' ? snapshot.promptZh : snapshot.promptEn,
    negativePrompt: null,
    referenceImages: references,
    aspectRatio: snapshot.params.aspectRatio,
    resolution: snapshot.params.resolution,
    count: snapshot.params.count,
    seed: snapshot.params.seed,
    extraParams: snapshot.params.extraParams
  };
}

/** 构造音频生成请求：音频类型取资产的音频类型，时长由内容决定。 */
function buildAudioRequest(version: AssetVersionRecord, asset: AssetRecord, modelCode: string): AudioGenerationRequest {
  const { snapshot } = version;
  return {
    modelCode,
    audioKind: readAudioKind(asset.attributes),
    prompt: snapshot.promptLanguage === 'zh' ? snapshot.promptZh : snapshot.promptEn,
    durationSeconds: null,
    language: snapshot.params.language,
    voice: snapshot.params.voice,
    referenceAudio: null,
    extraParams: snapshot.params.extraParams
  };
}

/** 适配器校验有问题时抛出参数错误。 */
function assertValid(issues: readonly string[]): void {
  if (issues.length > 0) {
    throw new ProviderError('invalid_request', issues.join('；'));
  }
}

/** 按 MIME 类型给出文件扩展名。 */
function extensionOf(mime: string): string {
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'audio/wav':
      return '.wav';
    case 'audio/mp4':
      return '.m4a';
    default:
      return '.mp3';
  }
}

/** 把任意错误转换为失败原因：服务商错误保留分类与错误码，其他按服务端错误记录。 */
function toFailure(error: unknown): AssetVersionFailure {
  if (error instanceof ProviderError) {
    return { category: error.category, code: error.code, message: error.message };
  }
  const detail = error instanceof Error ? error.message : String(error);
  return { category: 'server', code: null, message: `内部错误：${detail}` };
}
