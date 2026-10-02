// ------------------------------------------------------------------------
// 名称：generation-service.ts
// 说明：视频生成应用服务：提供工作台的作品、集、模型与镜头任务视图；按镜头编译请求并校验后提交；取消任务；定位结果文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；只有已确认采用的分镜脚本才能生成；每次提交产生新任务，失败原因与历史都保留，修改镜头后可再次提交。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ProviderError, ValidationError } from '../../domain/errors';
import {
  JOB_STATUS_LABELS,
  JobFailure,
  JobStatus,
  VideoJobRecord,
  VideoResultRecord
} from '../../domain/models/generation';
import { VideoCapability, VideoAudioMode } from '../../domain/models/model-capability';
import { ENTITY_KIND_LABELS, EntityKind } from '../../domain/models/screenplay';
import { StageDisplayStatus } from '../../domain/models/stage-run';
import { ShotRecord } from '../../domain/models/storyboard';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { BindingRepository } from '../../domain/ports/binding-repository';
import { GenerationRepository, JobMediaReader, ResultStore } from '../../domain/ports/generation-repository';
import { ResolvedVideoCall } from '../../domain/ports/provider-adapters';
import { ProviderRepository } from '../../domain/ports/provider-repository';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { EntityReferences, describeJobFailure, planShotRequest, readSubmitInput } from '../../domain/rules/generation-rules';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { JobChange } from '../queue/job-queue';
import { buildVideoRequest } from '../queue/video-request';
import { ChangeNotifier } from './change-notifier';
import { ProjectService } from './project-service';
import { ProviderService } from './provider-service';
import { StoryboardService, storyboardTarget } from './storyboard-service';
import { WorkService } from './work-service';

/** 每个镜头在视图中最多显示的任务数（最新的在前）。 */
const MAX_JOBS_PER_SHOT = 10;

/** 工作台里的一集。 */
export interface WorkbenchEpisode {
  readonly episodeId: number;
  readonly seq: number;
  readonly title: string;
  readonly display: StageDisplayStatus | 'none';
  readonly shotCount: number;
}

/** 工作台里的一个作品：有分镜脚本记录的作品及其集。 */
export interface WorkbenchWork {
  readonly id: number;
  readonly name: string;
  readonly projectName: string;
  readonly episodes: readonly WorkbenchEpisode[];
}

/** 可选的视频模型及其可选参数。 */
export interface WorkbenchModel {
  readonly id: number;
  readonly displayName: string;
  readonly providerName: string;
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
  readonly audioModes: readonly VideoAudioMode[];
}

/** 工作台的作品与模型清单。 */
export interface WorkbenchCatalog {
  readonly works: readonly WorkbenchWork[];
  readonly models: readonly WorkbenchModel[];
}

/** 失败原因的界面视图。 */
export interface JobFailureView extends JobFailure {
  /** 分类的界面名称，如“内容审核未通过”。 */
  readonly label: string;
  /** 下一步怎么做的建议。 */
  readonly hint: string;
}

/** 结果视频的界面视图。 */
export interface JobResultView {
  readonly id: number;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly hasAudio: boolean;
  readonly isSelected: boolean;
}

/** 一条任务的界面视图。 */
export interface JobView {
  readonly id: number;
  readonly attempt: number;
  readonly status: JobStatus;
  readonly statusLabel: string;
  readonly modelName: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly failure: JobFailureView | null;
  readonly warnings: readonly string[];
  readonly result: JobResultView | null;
}

/** 镜头出场实体的界面视图。 */
export interface ShotEntityView {
  readonly id: number;
  readonly name: string;
  readonly kindLabel: string;
  /** 是否已有形象绑定。 */
  readonly bound: boolean;
}

/** 一个镜头的界面视图：内容摘要与它的任务历史（最新的在前）。 */
export interface ShotView {
  readonly id: number;
  readonly seq: number;
  readonly sceneLabel: string;
  readonly shotSize: string;
  readonly action: string;
  readonly durationSeconds: number;
  readonly firstFrameMode: ShotRecord['firstFrameMode'];
  readonly soundCount: number;
  readonly entities: readonly ShotEntityView[];
  readonly jobs: readonly JobView[];
}

/** 一集的工作台视图。 */
export interface EpisodeWorkbenchView {
  readonly workId: number;
  readonly episodeId: number;
  readonly episodeTitle: string;
  /** 能否生成：分镜脚本必须已确认采用。 */
  readonly canGenerate: boolean;
  /** 不能生成时的原因；能生成时为 null。 */
  readonly blockReason: string | null;
  readonly shots: readonly ShotView[];
}

/** 一个被拒绝提交的镜头及其原因。 */
export interface RejectedShot {
  readonly shotId: number;
  readonly seq: number;
  readonly issues: readonly string[];
}

/** 提交结果：已入队的镜头、被拒绝的镜头与提醒。 */
export interface SubmitResult {
  readonly submitted: ReadonlyArray<{ readonly shotId: number; readonly seq: number; readonly jobId: number; readonly warnings: readonly string[] }>;
  readonly rejected: readonly RejectedShot[];
}

/** 提交后通知队列开始处理，以及取消任务；由 JobQueue 实现。 */
export interface JobScheduler {
  pump(): Promise<void>;
  cancel(jobId: number): Promise<{ readonly remoteCanceled: boolean }>;
}

/** 视频生成应用服务的依赖。 */
export interface GenerationServiceDependencies {
  readonly works: WorkService;
  readonly projects: ProjectService;
  readonly storyboardService: StoryboardService;
  readonly runs: StageRunRepository;
  readonly screenplays: ScreenplayRepository;
  readonly storyboards: StoryboardRepository;
  readonly bindings: BindingRepository;
  readonly assets: AssetRepository;
  readonly jobs: GenerationRepository;
  readonly media: JobMediaReader;
  readonly results: ResultStore;
  readonly models: Pick<ProviderRepository, 'findModelById'>;
  readonly providers: ProviderService;
  readonly scheduler: JobScheduler;
  readonly changes: ChangeNotifier<JobChange>;
  readonly now?: () => Date;
}

/** 视频生成应用服务。 */
export class GenerationService {
  constructor(private readonly dependencies: GenerationServiceDependencies) {}

  /** 订阅任务变化；返回取消订阅的函数。 */
  onDidChangeJobs(listener: (change: JobChange) => void): () => void {
    return this.dependencies.changes.subscribe(listener);
  }

  /** 列出工作台可选的作品（有分镜脚本记录的）与当前可用的视频模型。 */
  async getCatalog(): Promise<WorkbenchCatalog> {
    const { works, projects, storyboardService, providers } = this.dependencies;
    const projectNames = new Map(projects.listProjects().map((project) => [project.id, project.name]));
    const workItems: WorkbenchWork[] = [];
    for (const work of works.listAllWorks()) {
      const episodes = storyboardService
        .listEpisodeStatuses(work.id)
        .filter((status) => status.display !== 'none')
        .map(({ episodeId, seq, title, display, shotCount }) => ({ episodeId, seq, title, display, shotCount }));
      if (episodes.length > 0) {
        workItems.push({ id: work.id, name: work.name, projectName: projectNames.get(work.projectId) ?? '', episodes });
      }
    }
    const usable = await providers.listUsableModels('video');
    const models = usable.map(({ model, providerName }) => {
      const capability = model.capability as VideoCapability;
      return {
        id: model.id,
        displayName: model.displayName,
        providerName,
        aspectRatios: capability.aspectRatios,
        resolutions: capability.resolutions,
        audioModes: capability.audioModes
      };
    });
    return { works: workItems, models };
  }

  /**
   * 读取一集的工作台视图：镜头及其任务历史。
   * @param workId 作品标识。
   * @param episodeId 集标识。
   * @throws NotFoundError 作品或集不存在，或这一集还没有分镜脚本。
   */
  getEpisode(workId: number, episodeId: number): EpisodeWorkbenchView {
    const { works, storyboardService, runs, screenplays, storyboards, bindings, jobs } = this.dependencies;
    works.getWork(workId);
    const episode = storyboardService.listEpisodeStatuses(workId).find((status) => status.episodeId === episodeId);
    if (episode === undefined) {
      throw new NotFoundError('集不存在。');
    }
    const target = storyboardTarget(workId, episodeId);
    const current = runs.findCurrent(target);
    const run = current ?? runs.listVersions(target)[0];
    if (run === undefined) {
      throw new NotFoundError('这一集还没有分镜脚本。');
    }

    const entities = new Map(screenplays.listEntities(workId).map((entity) => [entity.id, entity]));
    const visualBound = new Set(
      bindings
        .listByEpisode(episodeId)
        .filter((binding) => binding.purpose === 'visual' && binding.isPrimary)
        .map((binding) => binding.entityId)
    );
    const shots = storyboards.listShots(run.id);
    const shotIds = shots.map((shot) => shot.id);
    const results = new Map<number, VideoResultRecord>(jobs.listResultsByShots(shotIds).map((result) => [result.jobId, result]));
    const jobsByShot = new Map<number, VideoJobRecord[]>();
    for (const job of jobs.listJobsByShots(shotIds)) {
      jobsByShot.set(job.shotId, [...(jobsByShot.get(job.shotId) ?? []), job]);
    }

    return {
      workId,
      episodeId,
      episodeTitle: episode.title,
      canGenerate: current !== undefined,
      blockReason: current === undefined ? describeBlockReason(run.status, run.reviewStatus) : null,
      shots: shots.map((shot) => ({
        id: shot.id,
        seq: shot.seq,
        sceneLabel: shot.sceneLabel,
        shotSize: shot.shotSize,
        action: shot.action,
        durationSeconds: shot.durationSeconds,
        firstFrameMode: shot.firstFrameMode,
        soundCount: shot.sounds.filter((sound) => sound.isEnabled).length,
        entities: shot.entityIds.flatMap((id) => {
          const entity = entities.get(id);
          return entity === undefined ? [] : [{ id, name: entity.name, kindLabel: ENTITY_KIND_LABELS[entity.kind], bound: visualBound.has(id) }];
        }),
        jobs: (jobsByShot.get(shot.id) ?? []).slice(0, MAX_JOBS_PER_SHOT).map((job) => this.toJobView(job, results.get(job.id)))
      }))
    };
  }

  /**
   * 提交若干镜头生成视频：逐个镜头编译请求并按模型能力校验，通过的写入任务并入队，不通过的连同原因一起返回，不影响其他镜头。
   * @param rawInput 界面提交的原始内容。
   * @throws ValidationError 内容不合法、分镜脚本尚未确认采用，或所选模型不可用。
   * @throws NotFoundError 作品不存在。
   */
  async submit(rawInput: unknown): Promise<SubmitResult> {
    const { works, runs, storyboards, jobs, media, providers, scheduler, changes } = this.dependencies;
    const input = readSubmitInput(rawInput);
    works.getWork(input.workId);
    const current = runs.findCurrent(storyboardTarget(input.workId, input.episodeId));
    if (current === undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '分镜脚本还没有确认采用，请先确认后再生成。' });
    }

    const usable = (await providers.listUsableModels('video')).find((candidate) => candidate.model.id === input.params.modelId);
    if (usable === undefined) {
      throw new ValidationError({ modelId: '所选模型不可用，请检查“设置 > 模型”里的启用状态和访问密钥。' });
    }
    let call: ResolvedVideoCall;
    try {
      call = await providers.resolveVideoCall(usable.model.id);
    } catch (error) {
      throw new ValidationError({ modelId: error instanceof ProviderError ? error.message : '所选模型不可用。' });
    }
    const capability = call.adapter.getCapability(call.modelCode);
    if (capability === undefined) {
      throw new ValidationError({ modelId: '所选模型不可用。' });
    }

    const shotsById = new Map(storyboards.listShots(current.id).map((shot) => [shot.id, shot]));
    const submitted: Array<SubmitResult['submitted'][number]> = [];
    const rejected: RejectedShot[] = [];
    for (const shotId of input.shotIds) {
      const shot = shotsById.get(shotId);
      if (shot === undefined) {
        rejected.push({ shotId, seq: 0, issues: ['镜头不属于当前已确认的分镜脚本。'] });
        continue;
      }
      if (jobs.hasActiveJob(shot.id)) {
        rejected.push({ shotId, seq: shot.seq, issues: ['这个镜头正在生成，完成或取消后才能再次提交。'] });
        continue;
      }
      const snapshot = planShotRequest({
        shot,
        storyboardRunId: current.id,
        providerCode: usable.providerCode,
        modelCode: call.modelCode,
        capability,
        params: input.params,
        entities: this.collectEntityReferences(input.workId, input.episodeId, shot)
      });
      let issues: readonly string[];
      try {
        issues = call.adapter.validate(buildVideoRequest(snapshot, null, media, call.modelCode));
      } catch (error) {
        issues = [error instanceof Error ? error.message : String(error)];
      }
      if (issues.length > 0) {
        rejected.push({ shotId, seq: shot.seq, issues });
        continue;
      }
      const job = jobs.insertJob({ shotId: shot.id, modelId: usable.model.id, status: 'queued', snapshot, prevJobId: null }, this.timestamp());
      submitted.push({ shotId, seq: shot.seq, jobId: job.id, warnings: snapshot.warnings });
      changes.notify({ jobId: job.id, shotId });
    }
    if (submitted.length > 0) {
      void scheduler.pump().catch((error: unknown) => console.error('处理生成队列时出现未预期的错误：', error));
    }
    return { submitted, rejected };
  }

  /**
   * 取消进行中的任务。
   * @param rawInput { jobId }。
   * @returns remoteCanceled 为 false 时，平台任务可能仍会继续并计费。
   * @throws NotFoundError 任务不存在或已经结束。
   */
  cancel(rawInput: unknown): Promise<{ readonly remoteCanceled: boolean }> {
    return this.dependencies.scheduler.cancel(readEntityId({ id: readRecord(rawInput).jobId }, '任务'));
  }

  /**
   * 取得结果视频的本机绝对路径，用于用系统播放器打开。
   * @param rawInput { resultId }。
   * @throws NotFoundError 结果不存在。
   */
  getResultPath(rawInput: unknown): string {
    const result = this.dependencies.jobs.findResult(readEntityId({ id: readRecord(rawInput).resultId }, '结果'));
    if (result === undefined) {
      throw new NotFoundError('结果视频不存在。');
    }
    return this.dependencies.results.resolvePath(result.filePath);
  }

  /** 收集镜头出场实体的绑定：每个实体取形象主资产与音色主资产的第一个参考文件。 */
  private collectEntityReferences(workId: number, episodeId: number, shot: ShotRecord): EntityReferences[] {
    const { screenplays, bindings, assets } = this.dependencies;
    const entities = new Map(screenplays.listEntities(workId).map((entity) => [entity.id, entity]));
    const episodeBindings = bindings.listByEpisode(episodeId).filter((binding) => binding.isPrimary);
    const firstFileId = (assetId: number): number | null => assets.listReferenceFiles(assetId)[0]?.id ?? null;
    return shot.entityIds.flatMap((entityId) => {
      const entity = entities.get(entityId);
      if (entity === undefined) return [];
      const visual = episodeBindings.find((binding) => binding.entityId === entityId && binding.purpose === 'visual');
      const voice = episodeBindings.find((binding) => binding.entityId === entityId && binding.purpose === 'voice');
      return [
        {
          entityId,
          name: entity.name,
          kind: entity.kind as EntityKind,
          visualFileId: visual === undefined ? null : firstFileId(visual.assetId),
          voiceFileId: voice === undefined ? null : firstFileId(voice.assetId)
        }
      ];
    });
  }

  private toJobView(job: VideoJobRecord, result: VideoResultRecord | undefined): JobView {
    const model = this.dependencies.models.findModelById(job.modelId);
    return {
      id: job.id,
      attempt: job.attempt,
      status: job.status,
      statusLabel: JOB_STATUS_LABELS[job.status],
      modelName: model?.displayName ?? '',
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      failure: job.failure === null ? null : { ...job.failure, ...describeJobFailure(job.failure) },
      warnings: job.snapshot.warnings,
      result:
        result === undefined
          ? null
          : { id: result.id, durationSeconds: result.durationSeconds, sizeBytes: result.sizeBytes, hasAudio: result.hasAudio, isSelected: result.isSelected }
    };
  }

  private timestamp(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

/** 没有已确认的分镜脚本时，说明为什么不能生成。 */
function describeBlockReason(status: string, reviewStatus: string): string {
  if (status === 'running') return '分镜脚本正在生成，完成并确认采用后才能生成视频。';
  if (status === 'failed' || status === 'canceled') return '分镜脚本没有生成成功，请先到“分镜”列表重新生成。';
  if (reviewStatus === 'pending') return '分镜脚本还没有确认采用（修改镜头后需要重新确认）。请点“查看分镜脚本”，确认采用后再生成。';
  return '分镜脚本尚未确认采用。';
}
