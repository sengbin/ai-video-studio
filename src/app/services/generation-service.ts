// ------------------------------------------------------------------------
// 名称：generation-service.ts
// 说明：视频生成应用服务：提供工作台的作品、集、模型与镜头组任务视图；按镜头组编译请求并校验后提交；重新分组、拆分与合并镜头组；取消任务；定位结果文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；一个镜头组一次生成一个多镜头视频；只有已确认采用的分镜脚本才能生成；每次提交产生新任务，失败原因与历史都保留；已有生成记录的组不能拆分或合并。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ProviderError, ValidationError } from '../../domain/errors';
import { JOB_STATUS_LABELS, JobFailure, JobStatus, VideoJobRecord, VideoResultRecord } from '../../domain/models/generation';
import { VideoAudioMode, VideoCapability } from '../../domain/models/model-capability';
import { EntityKind, ENTITY_KIND_LABELS } from '../../domain/models/screenplay';
import { StageDisplayStatus, StageRun } from '../../domain/models/stage-run';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { BindingRepository } from '../../domain/ports/binding-repository';
import { GenerationRepository, JobMediaReader, ResultStore } from '../../domain/ports/generation-repository';
import { ResolvedVideoCall } from '../../domain/ports/provider-adapters';
import { ProviderRepository } from '../../domain/ports/provider-repository';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { FieldErrors, assertNoFieldErrors, readEntityId, readInteger, readRecord } from '../../domain/rules/field-readers';
import { EntityReferences, describeJobFailure, maxGroupSeconds, planGroupRequest, readSubmitInput } from '../../domain/rules/generation-rules';
import {
  GROUP_SECONDS_MAX,
  GROUP_SECONDS_MIN,
  groupMaxSecondsOf,
  mergeLayoutIntoPrevious,
  splitLayoutBefore,
  sumSeconds
} from '../../domain/rules/shot-group-rules';
import { JobChange } from '../queue/job-queue';
import { buildVideoRequest } from '../queue/video-request';
import { ChangeNotifier } from './change-notifier';
import { ProjectService } from './project-service';
import { ProviderService } from './provider-service';
import { readGroupLayout, regroupShots, syncShotGroups } from './shot-grouping';
import { StoryboardService, readStoryboardParams, storyboardTarget } from './storyboard-service';
import { WorkService } from './work-service';

/** 每个镜头组在视图中最多显示的任务数（最新的在前）。 */
const MAX_JOBS_PER_GROUP = 10;
/** 失败通知里最多引用平台原文的字数，完整原文在工作台查看。 */
const FAILURE_NOTICE_LENGTH = 100;

/** 把文字转成可用作文件名的形式：去掉 Windows 不允许的字符。 */
function toFileName(text: string): string {
  return text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
}

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
  /** 单次最多可生成的时长（秒）；没有上限信息时为 null。镜头组超过它就不能用该模型生成。 */
  readonly maxGroupSeconds: number | null;
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

/** 任务提交时使用的生成参数（来自请求快照）。 */
export interface JobParamsView {
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  /** 整组视频的时长（秒）。 */
  readonly durationSeconds: number | null;
  readonly audioMode: VideoAudioMode | null;
  readonly seed: number | null;
}

/** 一条任务的界面视图。 */
export interface JobView {
  readonly id: number;
  readonly attempt: number;
  readonly status: JobStatus;
  readonly statusLabel: string;
  readonly modelName: string;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly finishedAt: string | null;
  /** 提交时使用的参数。 */
  readonly params: JobParamsView;
  /** 提交给模型的提示词全文。 */
  readonly prompt: string;
  readonly shotCount: number;
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

/** 组内一个镜头的界面视图。 */
export interface GroupShotView {
  readonly id: number;
  readonly seq: number;
  readonly sceneLabel: string;
  readonly shotSize: string;
  readonly action: string;
  readonly durationSeconds: number;
  readonly soundCount: number;
}

/** 一个镜头组的界面视图：组内镜头、出场实体与任务历史（最新的在前）。 */
export interface GroupView {
  readonly id: number;
  readonly seq: number;
  readonly shots: readonly GroupShotView[];
  /** 组内镜头时长之和（秒）。 */
  readonly totalSeconds: number;
  /** 组内出场的实体（去重）。 */
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
  /** 分镜脚本生成时设定的单组最长时长（秒）。 */
  readonly groupMaxSeconds: number;
  readonly groups: readonly GroupView[];
}

/** 一个被拒绝提交的镜头组及其原因。 */
export interface RejectedGroup {
  readonly groupId: number;
  readonly seq: number;
  readonly issues: readonly string[];
}

/** 提交结果：已入队的镜头组、被拒绝的镜头组与提醒。 */
export interface SubmitResult {
  readonly submitted: ReadonlyArray<{ readonly groupId: number; readonly seq: number; readonly jobId: number; readonly warnings: readonly string[] }>;
  readonly rejected: readonly RejectedGroup[];
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

/** 工作台使用的分镜脚本版本：已确认采用的当前版本，没有时取最新版本（只读）。 */
interface WorkbenchRun {
  readonly run: StageRun;
  readonly isCurrent: boolean;
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
        audioModes: capability.audioModes,
        maxGroupSeconds: maxGroupSeconds(capability.duration)
      };
    });
    return { works: workItems, models };
  }

  /**
   * 读取一集的工作台视图：镜头组、组内镜头及任务历史。读取时会补全还没有分组的镜头。
   * @param workId 作品标识。
   * @param episodeId 集标识。
   * @throws NotFoundError 作品或集不存在，或这一集还没有分镜脚本。
   */
  getEpisode(workId: number, episodeId: number): EpisodeWorkbenchView {
    const { works, storyboardService, screenplays, storyboards, bindings, jobs } = this.dependencies;
    works.getWork(workId);
    const episode = storyboardService.listEpisodeStatuses(workId).find((status) => status.episodeId === episodeId);
    if (episode === undefined) {
      throw new NotFoundError('集不存在。');
    }
    const { run, isCurrent } = this.resolveRun(workId, episodeId);
    const groupMax = groupMaxSecondsOf(readStoryboardParams(run));
    syncShotGroups(storyboards, run.id, groupMax, this.timestamp());

    const entities = new Map(screenplays.listEntities(workId).map((entity) => [entity.id, entity]));
    const visualBound = new Set(
      bindings
        .listByEpisode(episodeId)
        .filter((binding) => binding.purpose === 'visual' && binding.isPrimary)
        .map((binding) => binding.entityId)
    );
    const shots = new Map(storyboards.listShots(run.id).map((shot) => [shot.id, shot]));
    const groups = storyboards.listGroups(run.id);
    const groupIds = groups.map((group) => group.id);
    const results = new Map<number, VideoResultRecord>(jobs.listResultsByGroups(groupIds).map((result) => [result.jobId, result]));
    const jobsByGroup = new Map<number, VideoJobRecord[]>();
    for (const job of jobs.listJobsByGroups(groupIds)) {
      jobsByGroup.set(job.groupId, [...(jobsByGroup.get(job.groupId) ?? []), job]);
    }

    return {
      workId,
      episodeId,
      episodeTitle: episode.title,
      canGenerate: isCurrent,
      blockReason: isCurrent ? null : describeBlockReason(run.status, run.reviewStatus),
      groupMaxSeconds: groupMax,
      groups: groups.map((group) => {
        const members = group.shotIds.flatMap((id) => shots.get(id) ?? []);
        const entityIds = [...new Set(members.flatMap((shot) => shot.entityIds))];
        return {
          id: group.id,
          seq: group.seq,
          shots: members.map((shot) => ({
            id: shot.id,
            seq: shot.seq,
            sceneLabel: shot.sceneLabel,
            shotSize: shot.shotSize,
            action: shot.action,
            durationSeconds: shot.durationSeconds,
            soundCount: shot.sounds.filter((sound) => sound.isEnabled).length
          })),
          totalSeconds: sumSeconds(members),
          entities: entityIds.flatMap((id) => {
            const entity = entities.get(id);
            return entity === undefined ? [] : [{ id, name: entity.name, kindLabel: ENTITY_KIND_LABELS[entity.kind], bound: visualBound.has(id) }];
          }),
          jobs: (jobsByGroup.get(group.id) ?? []).slice(0, MAX_JOBS_PER_GROUP).map((job) => this.toJobView(job, results.get(job.id)))
        };
      })
    };
  }

  /**
   * 提交若干镜头组生成视频：逐组编译请求并按模型能力校验，通过的写入任务并入队，不通过的连同原因一起返回，不影响其他组。
   * @param rawInput 界面提交的原始内容。
   * @throws ValidationError 内容不合法、分镜脚本尚未确认采用，或所选模型不可用。
   * @throws NotFoundError 作品不存在。
   */
  async submit(rawInput: unknown): Promise<SubmitResult> {
    const { works, storyboards, jobs, media, providers, scheduler, changes } = this.dependencies;
    const input = readSubmitInput(rawInput);
    works.getWork(input.workId);
    const { run, isCurrent } = this.resolveRun(input.workId, input.episodeId);
    if (!isCurrent) {
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
    const modelMax = maxGroupSeconds(capability.duration);

    syncShotGroups(storyboards, run.id, groupMaxSecondsOf(readStoryboardParams(run)), this.timestamp());
    const shotsById = new Map(storyboards.listShots(run.id).map((shot) => [shot.id, shot]));
    const groupsById = new Map(storyboards.listGroups(run.id).map((group) => [group.id, group]));
    const submitted: Array<SubmitResult['submitted'][number]> = [];
    const rejected: RejectedGroup[] = [];
    for (const groupId of input.groupIds) {
      const group = groupsById.get(groupId);
      if (group === undefined) {
        rejected.push({ groupId, seq: 0, issues: ['镜头组不属于当前已确认的分镜脚本。'] });
        continue;
      }
      if (jobs.hasActiveJob(group.id)) {
        rejected.push({ groupId, seq: group.seq, issues: ['这一组正在生成，完成或取消后才能再次提交。'] });
        continue;
      }
      const members = group.shotIds.flatMap((id) => shotsById.get(id) ?? []);
      const total = sumSeconds(members);
      if (modelMax !== null && total > modelMax) {
        rejected.push({
          groupId,
          seq: group.seq,
          issues: [`这一组共 ${total} 秒，超过所选模型单次最长 ${modelMax} 秒。请拆分这一组、重新分组，或换一个支持更长时长的模型。`]
        });
        continue;
      }
      const snapshot = planGroupRequest({
        shots: members,
        storyboardRunId: run.id,
        providerCode: usable.providerCode,
        modelCode: call.modelCode,
        capability,
        params: input.params,
        entities: this.collectEntityReferences(input.workId, input.episodeId, [...new Set(members.flatMap((shot) => shot.entityIds))])
      });
      let issues: readonly string[];
      try {
        issues = call.adapter.validate(buildVideoRequest(snapshot, null, media, call.modelCode));
      } catch (error) {
        issues = [error instanceof Error ? error.message : String(error)];
      }
      if (issues.length > 0) {
        rejected.push({ groupId, seq: group.seq, issues });
        continue;
      }
      const job = jobs.insertJob({ groupId: group.id, modelId: usable.model.id, status: 'queued', snapshot, prevJobId: null }, this.timestamp());
      submitted.push({ groupId, seq: group.seq, jobId: job.id, warnings: snapshot.warnings });
      changes.notify({ jobId: job.id, groupId });
    }
    if (submitted.length > 0) {
      void scheduler.pump().catch((error: unknown) => console.error('处理生成队列时出现未预期的错误：', error));
    }
    return { submitted, rejected };
  }

  /**
   * 丢弃这一集现有的镜头组，按单组最长时长重新分组。已有的生成记录会随旧的组一起清除，已保存的视频文件不删除。
   * @param rawInput { workId, episodeId, maxSeconds? }，maxSeconds 缺省用分镜脚本生成时设定的值。
   * @throws ValidationError 内容不合法，或有正在生成的组。
   * @throws NotFoundError 作品、集不存在或还没有分镜脚本。
   */
  regroup(rawInput: unknown): void {
    const { storyboards, jobs } = this.dependencies;
    const source = readRecord(rawInput);
    const { run } = this.resolveEpisodeRun(source);
    let maxSeconds = groupMaxSecondsOf(readStoryboardParams(run));
    if (source.maxSeconds !== undefined && source.maxSeconds !== null) {
      const errors: FieldErrors = {};
      maxSeconds = readInteger(source, { key: 'maxSeconds', label: '单组最长时长', required: true, min: GROUP_SECONDS_MIN, max: GROUP_SECONDS_MAX }, errors);
      assertNoFieldErrors(errors);
    }
    const groups = storyboards.listGroups(run.id);
    if (groups.some((group) => jobs.hasActiveJob(group.id))) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '有镜头组正在生成，完成或取消后才能重新分组。' });
    }
    regroupShots(storyboards, run.id, maxSeconds, this.timestamp());
  }

  /**
   * 在某个镜头之前拆开所在的组（该镜头及后面的镜头成为新组）。
   * @param rawInput { workId, episodeId, shotId }。
   * @throws ValidationError 镜头已是组内第一个，或所在的组已有生成记录。
   */
  splitGroup(rawInput: unknown): void {
    const { storyboards } = this.dependencies;
    const source = readRecord(rawInput);
    const { run } = this.resolveEpisodeRun(source);
    const shotId = readEntityId({ id: source.shotId }, '镜头');
    const layout = readGroupLayout(storyboards, run.id);
    const next = splitLayoutBefore(layout, shotId);
    const affected = layout.find((entry) => entry.shotIds.includes(shotId))?.groupId;
    this.assertNoJobs(affected === undefined || affected === null ? [] : [affected]);
    storyboards.applyGroupLayout(run.id, next, this.timestamp());
  }

  /**
   * 把一个组并入上一组。
   * @param rawInput { workId, episodeId, groupId }。
   * @throws ValidationError 已是第一组，或这两组有生成记录。
   */
  mergeGroup(rawInput: unknown): void {
    const { storyboards } = this.dependencies;
    const source = readRecord(rawInput);
    const { run } = this.resolveEpisodeRun(source);
    const groupId = readEntityId({ id: source.groupId }, '镜头组');
    const layout = readGroupLayout(storyboards, run.id);
    const next = mergeLayoutIntoPrevious(layout, groupId);
    const index = layout.findIndex((entry) => entry.groupId === groupId);
    this.assertNoJobs([groupId, layout[index - 1].groupId as number]);
    storyboards.applyGroupLayout(run.id, next, this.timestamp());
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

  /**
   * 取得结果视频的本机路径和建议的导出文件名（“作品-第 N 集-第 M 组-第 K 次.mp4”），用于导出。
   * @param rawInput { resultId }。
   * @throws NotFoundError 结果不存在。
   */
  getResultFile(rawInput: unknown): { readonly path: string; readonly suggestedName: string } {
    const { jobs } = this.dependencies;
    const result = jobs.findResult(readEntityId({ id: readRecord(rawInput).resultId }, '结果'));
    if (result === undefined) {
      throw new NotFoundError('结果视频不存在。');
    }
    const job = jobs.findJob(result.jobId);
    const place = job === undefined ? undefined : this.locateJob(job);
    const stem = place === undefined ? `视频-${result.id}` : `${place.workName}-第${place.episodeSeq}集-第${place.groupSeq}组-第${job?.attempt}次`;
    return { path: this.dependencies.results.resolvePath(result.filePath), suggestedName: `${toFileName(stem)}.mp4` };
  }

  /**
   * 任务成功或失败后给用户的通知内容；任务还在进行、已取消或不存在时返回 undefined。
   * @param jobId 任务标识。
   */
  describeFinishedJob(jobId: number): { readonly status: 'succeeded' | 'failed'; readonly level: 'info' | 'warning'; readonly message: string } | undefined {
    const job = this.dependencies.jobs.findJob(jobId);
    if (job === undefined || (job.status !== 'succeeded' && job.status !== 'failed')) {
      return undefined;
    }
    const place = this.locateJob(job);
    const label = place === undefined ? '镜头组' : `「${place.workName}」第 ${place.episodeSeq} 集第 ${place.groupSeq} 组`;
    if (job.status === 'succeeded' || job.failure === null) {
      return { status: 'succeeded', level: 'info', message: `${label}的视频已生成。` };
    }
    const detail = job.failure.message.length > FAILURE_NOTICE_LENGTH ? `${job.failure.message.slice(0, FAILURE_NOTICE_LENGTH)}…` : job.failure.message;
    return { status: 'failed', level: 'warning', message: `${label}生成失败：${describeJobFailure(job.failure).label}。${detail}` };
  }

  /** 任务所属的作品名、集序号和镜头组序号；任何一项找不到（如作品已删除）时返回 undefined。 */
  private locateJob(job: VideoJobRecord): { readonly workName: string; readonly episodeSeq: number; readonly groupSeq: number } | undefined {
    const { jobs, works, storyboardService, storyboards } = this.dependencies;
    const location = jobs.getGroupLocation(job.groupId);
    if (location === undefined) {
      return undefined;
    }
    let workName: string;
    try {
      workName = works.getWork(location.workId).name;
    } catch {
      return undefined;
    }
    const episodeSeq = storyboardService.listEpisodeStatuses(location.workId).find((status) => status.episodeId === location.episodeId)?.seq;
    const groupSeq = storyboards.listGroups(job.snapshot.storyboardRunId).find((group) => group.id === job.groupId)?.seq;
    return episodeSeq === undefined || groupSeq === undefined ? undefined : { workName, episodeSeq, groupSeq };
  }

  /** 工作台使用的分镜脚本版本；这一集还没有分镜脚本时报错。 */
  private resolveRun(workId: number, episodeId: number): WorkbenchRun {
    const { runs } = this.dependencies;
    const target = storyboardTarget(workId, episodeId);
    const current = runs.findCurrent(target);
    const run = current ?? runs.listVersions(target)[0];
    if (run === undefined) {
      throw new NotFoundError('这一集还没有分镜脚本。');
    }
    return { run, isCurrent: current !== undefined };
  }

  /** 读取请求中的作品与集，返回对应的分镜脚本版本。 */
  private resolveEpisodeRun(source: Record<string, unknown>): WorkbenchRun {
    const workId = readEntityId({ id: source.workId }, '作品');
    const episodeId = readEntityId({ id: source.episodeId }, '集');
    this.dependencies.works.getWork(workId);
    return this.resolveRun(workId, episodeId);
  }

  /** 这些镜头组已有生成记录时不能调整成员。 */
  private assertNoJobs(groupIds: readonly number[]): void {
    if (this.dependencies.jobs.listJobsByGroups(groupIds).length > 0) {
      throw new ValidationError({
        [FORM_LEVEL_ERROR_KEY]: '这一组已经有生成记录，不能拆分或合并。需要调整时请使用“重新分组”（会清除本集已有的生成记录）。'
      });
    }
  }

  /** 收集出场实体的绑定：每个实体取形象主资产与音色主资产的第一个参考文件，顺序与给定的标识一致。 */
  private collectEntityReferences(workId: number, episodeId: number, entityIds: readonly number[]): EntityReferences[] {
    const { screenplays, bindings, assets } = this.dependencies;
    const entities = new Map(screenplays.listEntities(workId).map((entity) => [entity.id, entity]));
    const episodeBindings = bindings.listByEpisode(episodeId).filter((binding) => binding.isPrimary);
    const firstFileId = (assetId: number): number | null => assets.listReferenceFiles(assetId)[0]?.id ?? null;
    return entityIds.flatMap((entityId) => {
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
      submittedAt: job.submittedAt,
      finishedAt: job.finishedAt,
      params: {
        aspectRatio: job.snapshot.params.aspectRatio,
        resolution: job.snapshot.params.resolution,
        durationSeconds: job.snapshot.params.durationSeconds,
        audioMode: job.snapshot.params.audioMode,
        seed: job.snapshot.params.seed
      },
      prompt: job.snapshot.prompt,
      shotCount: job.snapshot.shotIds.length,
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
