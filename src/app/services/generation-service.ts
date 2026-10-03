// ------------------------------------------------------------------------
// 名称：generation-service.ts
// 说明：视频生成应用服务：提供工作台的作品、集、模型与镜头组任务视图；按镜头组编译请求并校验后提交；重新分组、拆分与合并镜头组；取消任务；切换镜头组采用的结果版本；读取镜头组的全部历史成功版本；定位结果文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；一个镜头组一次生成一个多镜头视频；只有已确认采用的分镜脚本才能生成；每次提交产生新任务，失败原因与历史都保留；已有生成记录的组不能拆分或合并；组的第一个镜头设为“上一镜头尾帧作首帧”时，任务等待上一组，尾帧由工作台截取后入库；上一组改用其他版本后，接在旧尾帧之后采用的组只提示、不自动重做；同一镜头组同时只有一个进行中的任务（提交时在事务内检查并插入，冲突的组被拒绝）。
// ------------------------------------------------------------------------

import { ConflictError, FORM_LEVEL_ERROR_KEY, NotFoundError, ProviderError, ValidationError } from '../../domain/errors';
import { ACTIVE_JOB_STATUSES, GenerationParams, JOB_STATUS_LABELS, JobFailure, JobStatus, VideoJobRecord, VideoResultRecord } from '../../domain/models/generation';
import { DEFAULT_NEGATIVE_LIST, EMPTY_PROFILE, NEGATIVE_LIST_PRESETS, ProfileValues } from '../../domain/models/generation-profile';
import { DurationCapability, VideoAudioElement, VideoAudioMode, VideoCapability } from '../../domain/models/model-capability';
import { EntityKind, ENTITY_KIND_LABELS } from '../../domain/models/screenplay';
import { StageDisplayStatus, StageRun } from '../../domain/models/stage-run';
import { ShotGroup, ShotRecord } from '../../domain/models/storyboard';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { BindingRepository } from '../../domain/ports/binding-repository';
import { GenerationProfileRepository } from '../../domain/ports/generation-profile-repository';
import { GenerationRepository, JobMediaReader, ResultStore } from '../../domain/ports/generation-repository';
import { ResolvedVideoCall } from '../../domain/ports/provider-adapters';
import { ProviderRepository } from '../../domain/ports/provider-repository';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { FieldErrors, assertNoFieldErrors, readEntityId, readInteger, readRecord } from '../../domain/rules/field-readers';
import { applyProfileChanges, readProfileChanges } from '../../domain/rules/generation-profile-rules';
import {
  EntityReferences,
  TAIL_FRAME_MAX_BYTES,
  TAIL_FRAME_UNAVAILABLE_CODE,
  describeJobFailure,
  maxGroupSeconds,
  planGroupRequest,
  readSubmitInput,
  readTailFrameFailure,
  readTailFrameInput,
  validateGroupParams
} from '../../domain/rules/generation-rules';
import { describeDuration } from '../../domain/rules/model-capability-rules';
import {
  GROUP_SECONDS_MAX,
  GROUP_SECONDS_MIN,
  groupMaxSecondsOf,
  mergeLayoutIntoPrevious,
  splitLayoutBefore,
  sumSeconds
} from '../../domain/rules/shot-group-rules';
import { JobCancelResult, JobChange } from '../queue/job-queue';
import { buildVideoRequest, PLACEHOLDER_FIRST_FRAME } from '../queue/video-request';
import { ChangeNotifier } from './change-notifier';
import { ProjectService } from './project-service';
import { ProviderService } from './provider-service';
import { readGroupLayout, regroupShots, syncShotGroups } from './shot-grouping';
import { StoryboardService, readStoryboardParams, readStoryboardStyle, storyboardTarget } from './storyboard-service';
import { WorkService } from './work-service';

/** 每个镜头组在工作台视图中最多显示的任务数（最新的在前）；结果版本页另用 getGroupVersions 读取全部成功版本。 */
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
  /** 原生支持的声音内容。 */
  readonly audioElements: readonly VideoAudioElement[];
  /** 是否支持随机种子；不支持时参数页签的种子置灰。 */
  readonly supportsSeed: boolean;
  /** 是否支持提示词改写开关；不支持时参数页签的开关置灰。 */
  readonly supportsPromptExtend: boolean;
  /** 时长约束，页面据此检查本组指定的生成时长。 */
  readonly duration: DurationCapability;
  /** 时长约束的文字描述，如“2–30 秒，可由模型自动决定”。 */
  readonly durationText: string;
  /** 单次最多可生成的时长（秒）；没有上限信息时为 null。镜头组超过它就不能用该模型生成。 */
  readonly maxGroupSeconds: number | null;
}

/** 工作台的作品与模型清单。 */
export interface WorkbenchCatalog {
  readonly works: readonly WorkbenchWork[];
  readonly models: readonly WorkbenchModel[];
  /** 提示词相关的默认值，参数页签据此说明“当前生效”并提供常用项。 */
  readonly promptDefaults: { readonly negativeList: string; readonly negativePresets: readonly string[] };
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
  /** 实际传给模型的声音内容；声音模式不是原生生成、或早期版本提交的任务为 null。 */
  readonly audioElements: readonly VideoAudioElement[] | null;
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
  /** 是否以上一组的尾帧作首帧。 */
  readonly usesPreviousTail: boolean;
  /** 是否以指定的图片作首帧。 */
  readonly usesFirstFrameImage: boolean;
  /** 提示词格式版本，用于区分不同写法编译出的提示词；早期版本提交的任务为 1。 */
  readonly promptFormat: number;
  /** 等待前序时说明在等什么；其他状态为 null。 */
  readonly waitNote: string | null;
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
  /** 这一组自己的参数覆盖；字段为 null 表示沿用本集、作品或项目的取值。 */
  readonly overrides: ProfileValues;
  /** 采用的结果视频；还没有成功的结果时为 null。 */
  readonly selectedResultId: number | null;
  /** 采用的视频接在上一组的旧尾帧之后（上一组后来改用了其他版本）时的说明；否则为 null。 */
  readonly staleNote: string | null;
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

/** 提交前预览中一个镜头组的汇总。 */
export interface GroupPreview {
  readonly groupId: number;
  readonly seq: number;
  readonly shotCount: number;
  /** 组内镜头时长之和（秒）。 */
  readonly totalSeconds: number;
  /** 按模型能力对齐后提交的整组时长（秒）；组不能提交时为 null。 */
  readonly durationSeconds: number | null;
  readonly firstFrame: 'none' | 'previous_tail' | 'image';
  /** 将要提交的完整提示词；组不能提交时为 null。 */
  readonly prompt: string | null;
  /** 实际写在提示词末尾的负向清单；没有或组不能提交时为 null。 */
  readonly negativeList: string | null;
  /** 提示词改写开关；null 表示不传，由平台用默认值。 */
  readonly promptExtend: boolean | null;
  readonly referenceImageCount: number;
  readonly referenceAudioCount: number;
  readonly audioMode: VideoAudioMode | null;
  /** 实际传给模型的声音内容；声音模式不是原生生成、或组不能提交时为 null。 */
  readonly audioElements: readonly VideoAudioElement[] | null;
  /** 本组使用的随机种子；为空表示随机。 */
  readonly seed: number | null;
  /** 阻断问题：有任何一条时这一组不能提交。 */
  readonly blocking: readonly string[];
  /** 提醒：不阻止提交。 */
  readonly warnings: readonly string[];
}

/** 提交预览：按组序号排列的各镜头组汇总。 */
export interface SubmitPreview {
  readonly groups: readonly GroupPreview[];
}

/** 指定图片首帧解析出的资产图片文件及其像素尺寸（未知为 null）。 */
interface ResolvedFirstFrameImage {
  readonly fileId: number;
  readonly width: number | null;
  readonly height: number | null;
}

/** 预览时代替真实任务标识，让同一次预览里后一组能接在前一组之后。 */
const DRY_RUN_JOB_ID = -1;
/** 这一组首帧所依赖的前序任务，以及已就绪的首帧（尾帧图片）；尾帧还没截取时为 null。 */
interface FirstFrameLink {
  readonly prevJobId: number;
  readonly firstFrameId: number | null;
}

/** 提交后通知队列开始处理，以及取消任务；由 JobQueue 实现。 */
export interface JobScheduler {
  pump(): Promise<void>;
  cancel(jobId: number): Promise<JobCancelResult>;
}

/** 一个视频模型的调用信息。 */
interface ModelContext {
  readonly usable: Awaited<ReturnType<ProviderService['listUsableModels']>>[number];
  readonly call: ResolvedVideoCall;
  readonly capability: VideoCapability;
  /** 模型单次最长时长（秒）；没有上限信息时为 null。 */
  readonly modelMax: number | null;
}

/** 用镜头组的覆盖替换本次提交的参数：覆盖里不为 null 的字段优先。 */
function mergeGroupParams(base: GenerationParams, override: ProfileValues | undefined): GenerationParams {
  if (override === undefined) return base;
  return {
    modelId: override.modelId ?? base.modelId,
    aspectRatio: override.aspectRatio ?? base.aspectRatio,
    resolution: override.resolution ?? base.resolution,
    audioMode: override.audioMode ?? base.audioMode,
    audioElements: override.audioElements ?? base.audioElements,
    seed: override.seed ?? base.seed,
    durationSeconds: override.durationSeconds ?? base.durationSeconds,
    negativeList: override.negativeList ?? base.negativeList,
    promptExtend: override.promptExtend ?? base.promptExtend
  };
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
  /** 镜头组级的生成参数覆盖。 */
  readonly profiles: GenerationProfileRepository;
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
        audioElements: capability.audioElements,
        supportsSeed: capability.seed,
        supportsPromptExtend: capability.promptExtend === true,
        duration: capability.duration,
        durationText: describeDuration(capability.duration),
        maxGroupSeconds: maxGroupSeconds(capability.duration)
      };
    });
    return { works: workItems, models, promptDefaults: { negativeList: DEFAULT_NEGATIVE_LIST, negativePresets: NEGATIVE_LIST_PRESETS } };
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
    const groupOverrides = this.dependencies.profiles.listByGroups(groupIds);
    const resultList = jobs.listResultsByGroups(groupIds);
    const results = new Map<number, VideoResultRecord>(resultList.map((result) => [result.jobId, result]));
    const selectedByGroup = new Map<number, VideoResultRecord>(resultList.filter((result) => result.isSelected).map((result) => [result.groupId, result]));
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
      groups: groups.map((group, index) => {
        const members = group.shotIds.flatMap((id) => shots.get(id) ?? []);
        const groupJobs = jobsByGroup.get(group.id) ?? [];
        const selected = selectedByGroup.get(group.id);
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
          overrides: groupOverrides.get(group.id) ?? EMPTY_PROFILE,
          jobs: pickVisibleJobs(groupJobs, selected?.jobId).map((job) => this.toJobView(job, results.get(job.id))),
          selectedResultId: selected?.id ?? null,
          staleNote: describeStaleTail(groupJobs, selected, groups[index - 1] === undefined ? undefined : selectedByGroup.get(groups[index - 1].id))
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
    return (await this.processSubmission(rawInput, false)).result;
  }

  /**
   * 预览提交：与 submit 做同样的编译与校验，但不写任务、不入队；逐组汇总整组时长、首帧来源、参考素材数量与声音，以及阻断问题和提醒。
   * @param rawInput 与 submit 相同。
   * @throws ValidationError 内容不合法、分镜脚本尚未确认采用，或所选模型不可用。
   * @throws NotFoundError 作品不存在。
   */
  async previewSubmit(rawInput: unknown): Promise<SubmitPreview> {
    return { groups: (await this.processSubmission(rawInput, true)).previews };
  }

  /** submit 与 previewSubmit 共用的处理：dryRun 为 true 时不写任务、不通知、不唤醒队列。 */
  private async processSubmission(rawInput: unknown, dryRun: boolean): Promise<{ readonly result: SubmitResult; readonly previews: GroupPreview[] }> {
    const { works, storyboards, jobs, media, scheduler, changes } = this.dependencies;
    const input = readSubmitInput(rawInput);
    works.getWork(input.workId);
    const { run, isCurrent } = this.resolveRun(input.workId, input.episodeId);
    if (!isCurrent) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '分镜脚本还没有确认采用，请先确认后再生成。' });
    }

    // 每个模型只解析一次：本次提交的默认模型必须可用，镜头组单独指定的模型不可用时只拒绝那一组。
    const contexts = new Map<number, ModelContext | string>();
    const contextOf = async (modelId: number): Promise<ModelContext | string> => {
      const cached = contexts.get(modelId);
      if (cached !== undefined) return cached;
      const resolved = await this.resolveModelContext(modelId);
      contexts.set(modelId, resolved);
      return resolved;
    };
    const baseContext = await contextOf(input.params.modelId);
    if (typeof baseContext === 'string') {
      throw new ValidationError({ modelId: baseContext });
    }
    const overrides = this.dependencies.profiles.listByGroups(input.groupIds);

    syncShotGroups(storyboards, run.id, groupMaxSecondsOf(readStoryboardParams(run)), this.timestamp());
    const shotsById = new Map(storyboards.listShots(run.id).map((shot) => [shot.id, shot]));
    const groupList = storyboards.listGroups(run.id);
    const groupsById = new Map(groupList.map((group) => [group.id, group]));
    // 按组序号依次处理，这样同一次提交里后一组能接在前一组刚建的任务后面。
    const orderOf = new Map(groupList.map((group, index) => [group.id, index]));
    const orderedGroupIds = [...input.groupIds].sort((left, right) => (orderOf.get(left) ?? Number.MAX_SAFE_INTEGER) - (orderOf.get(right) ?? Number.MAX_SAFE_INTEGER));
    const createdJobIds = new Map<number, number>();
    const submitted: Array<SubmitResult['submitted'][number]> = [];
    const rejected: RejectedGroup[] = [];
    const previews: GroupPreview[] = [];
    const memberShots = (group: ShotGroup | undefined): ShotRecord[] => (group === undefined ? [] : group.shotIds.flatMap((id) => shotsById.get(id) ?? []));
    /** 记录被拒绝的组：同时产生一条只有阻断问题的预览。 */
    const reject = (groupId: number, group: ShotGroup | undefined, issues: readonly string[]): void => {
      const members = memberShots(group);
      rejected.push({ groupId, seq: group?.seq ?? 0, issues });
      previews.push({
        groupId,
        seq: group?.seq ?? 0,
        shotCount: members.length,
        totalSeconds: sumSeconds(members),
        durationSeconds: null,
        firstFrame: 'none',
        prompt: null,
        negativeList: null,
        promptExtend: input.params.promptExtend,
        referenceImageCount: 0,
        referenceAudioCount: 0,
        audioMode: input.params.audioMode,
        audioElements: null,
        seed: input.params.seed,
        blocking: issues,
        warnings: []
      });
    };
    for (const groupId of orderedGroupIds) {
      const group = groupsById.get(groupId);
      if (group === undefined) {
        reject(groupId, undefined, ['镜头组不属于当前已确认的分镜脚本。']);
        continue;
      }
      if (jobs.hasActiveJob(group.id)) {
        reject(groupId, group, ['这一组正在生成，完成或取消后才能再次提交。']);
        continue;
      }
      const members = memberShots(group);
      const total = sumSeconds(members);
      // 这一组自己的覆盖优先于本次提交的参数；覆盖了模型时按那个模型校验。
      const groupParams = mergeGroupParams(input.params, overrides.get(group.id));
      const resolvedContext = groupParams.modelId === input.params.modelId ? baseContext : await contextOf(groupParams.modelId);
      if (typeof resolvedContext === 'string') {
        reject(groupId, group, [`这一组指定的视频模型不可用：${resolvedContext}`]);
        continue;
      }
      const { usable, call, capability, modelMax } = resolvedContext;
      if (modelMax !== null && total > modelMax) {
        reject(groupId, group, [`这一组共 ${total} 秒，超过所选模型单次最长 ${modelMax} 秒。请拆分这一组、重新分组，或换一个支持更长时长的模型。`]);
        continue;
      }
      const paramIssues = validateGroupParams(capability, groupParams, total);
      if (paramIssues.length > 0) {
        reject(groupId, group, paramIssues);
        continue;
      }
      // 组的第一个镜头指定图片作首帧：取该资产的第一张参考图；模型不支持首帧或图片已不可用时拒绝这一组。
      let firstFrameImage: ResolvedFirstFrameImage | null = null;
      if (members[0]?.firstFrameMode === 'asset') {
        if (!capability.firstFrame) {
          reject(groupId, group, ['所选模型不支持首帧输入，无法用指定图片作首帧。请换一个支持首帧的模型，或点“编辑镜头”把首帧来源改为“无”。']);
          continue;
        }
        const resolved = this.resolveFirstFrameFile(members[0].firstFrameAssetId);
        if (typeof resolved === 'string') {
          reject(groupId, group, [resolved]);
          continue;
        }
        firstFrameImage = resolved;
      }
      // 组的第一个镜头设为“上一镜头尾帧作首帧”时，这一组要接在上一组后面（第一组没有上一组，不适用）。
      let link: FirstFrameLink | undefined;
      const previousGroup = groupList[(orderOf.get(group.id) ?? 0) - 1] as ShotGroup | undefined;
      if (members[0]?.firstFrameMode === 'prev_tail' && previousGroup !== undefined) {
        if (!capability.firstFrame) {
          reject(groupId, group, ['所选模型不支持首帧输入，无法用上一组的尾帧作首帧。请换一个支持首帧的模型，或点“编辑镜头”把首帧来源改为“无”。']);
          continue;
        }
        const found = this.linkPreviousGroup(previousGroup, createdJobIds);
        if (typeof found === 'string') {
          reject(groupId, group, [found]);
          continue;
        }
        link = found;
      }
      const snapshot = planGroupRequest({
        shots: members,
        storyboardRunId: run.id,
        providerCode: usable.providerCode,
        modelCode: call.modelCode,
        capability,
        params: groupParams,
        entities: this.collectEntityReferences(input.workId, input.episodeId, [...new Set(members.flatMap((shot) => shot.entityIds))]),
        useFirstFrame: link !== undefined,
        firstFrameFileId: firstFrameImage === null ? null : firstFrameImage.fileId,
        firstFrameSize: firstFrameImage === null ? null : { width: firstFrameImage.width, height: firstFrameImage.height },
        style: readStoryboardStyle(run)
      });
      let issues: readonly string[];
      try {
        const request = buildVideoRequest(snapshot, null, media, call.modelCode);
        issues = call.adapter.validate(link === undefined ? request : { ...request, firstFrame: PLACEHOLDER_FIRST_FRAME });
      } catch (error) {
        issues = [error instanceof Error ? error.message : String(error)];
      }
      if (issues.length > 0) {
        reject(groupId, group, issues);
        continue;
      }
      let jobId = DRY_RUN_JOB_ID;
      if (!dryRun) {
        let job: VideoJobRecord;
        try {
          // 仓库在同一个事务里检查并插入；前面的检查之后又有别的提交抢先时，这里会因“同一组只能有一个进行中的任务”冲突。
          job = jobs.insertJob(
            {
              groupId: group.id,
              modelId: usable.model.id,
              status: link === undefined || link.firstFrameId !== null ? 'queued' : 'waiting',
              snapshot,
              prevJobId: link === undefined ? null : link.prevJobId,
              firstFrameId: link === undefined ? null : link.firstFrameId
            },
            this.timestamp()
          );
        } catch (error) {
          if (error instanceof ConflictError) {
            reject(groupId, group, [error.message]);
            continue;
          }
          throw error;
        }
        jobId = job.id;
        changes.notify({ jobId, groupId });
      }
      createdJobIds.set(group.id, jobId);
      submitted.push({ groupId, seq: group.seq, jobId, warnings: snapshot.warnings });
      previews.push({
        groupId,
        seq: group.seq,
        shotCount: members.length,
        totalSeconds: total,
        durationSeconds: snapshot.params.durationSeconds,
        firstFrame: link === undefined ? (firstFrameImage === null ? 'none' : 'image') : 'previous_tail',
        prompt: snapshot.prompt,
        negativeList: snapshot.params.negativeList ?? null,
        promptExtend: snapshot.params.extraParams.promptExtend === undefined ? null : snapshot.params.extraParams.promptExtend === true,
        referenceImageCount: snapshot.referenceImageFileIds.length,
        referenceAudioCount: snapshot.referenceAudioFileIds.length,
        audioMode: snapshot.params.audioMode,
        audioElements: snapshot.params.audioElements ?? null,
        seed: snapshot.params.seed,
        blocking: [],
        warnings: jobs.listResultsByGroups([group.id]).length > 0 ? [...snapshot.warnings, '这一组已有成功的结果，本次会产生新的版本，不会覆盖已有视频。'] : snapshot.warnings
      });
    }
    if (!dryRun && submitted.length > 0) {
      void scheduler.pump().catch((error: unknown) => console.error('处理生成队列时出现未预期的错误：', error));
    }
    return { result: { submitted, rejected }, previews };
  }
  /** 解析一个视频模型的调用信息；不可用时返回说明原因的文字。 */
  private async resolveModelContext(modelId: number): Promise<ModelContext | string> {
    const { providers } = this.dependencies;
    const usable = (await providers.listUsableModels('video')).find((candidate) => candidate.model.id === modelId);
    if (usable === undefined) {
      return '所选模型不可用，请检查“设置 > 模型”里的启用状态和访问密钥。';
    }
    let call: ResolvedVideoCall;
    try {
      call = await providers.resolveVideoCall(usable.model.id);
    } catch (error) {
      return error instanceof ProviderError ? error.message : '所选模型不可用。';
    }
    const capability = call.adapter.getCapability(call.modelCode);
    if (capability === undefined) {
      return '所选模型不可用。';
    }
    return { usable, call, capability, modelMax: maxGroupSeconds(capability.duration) };
  }

  /**
   * 保存一个镜头组的参数覆盖：changes 里出现的字段被覆盖，值为 null（或空串）表示恢复继承。
   * @param rawInput `{ workId, episodeId, groupId, changes }`。
   * @returns 保存后这一组的覆盖。
   * @throws ValidationError 字段不合法、模型不是可用的视频模型，或镜头组不属于当前的分镜脚本。
   * @throws NotFoundError 作品不存在。
   */
  saveGroupProfile(rawInput: unknown): ProfileValues {
    const { works, storyboards, profiles, models } = this.dependencies;
    const source = readRecord(rawInput);
    const workId = readEntityId({ id: source.workId }, '作品');
    const episodeId = readEntityId({ id: source.episodeId }, '集');
    const groupId = readEntityId({ id: source.groupId }, '镜头组');
    const changes = readProfileChanges(source.changes);
    works.getWork(workId);
    const { run } = this.resolveRun(workId, episodeId);
    if (!storyboards.listGroups(run.id).some((group) => group.id === groupId)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '镜头组不属于这一集当前的分镜脚本。' });
    }
    if (changes.modelId !== undefined && changes.modelId !== null) {
      const model = models.findModelById(changes.modelId);
      if (model === undefined || model.kind !== 'video') {
        throw new ValidationError({ modelId: '所选模型不存在或不是视频模型。' });
      }
    }
    const target = { scope: 'group', groupId } as const;
    const next = applyProfileChanges(profiles.find(target) ?? EMPTY_PROFILE, changes);
    profiles.save(target, next, this.timestamp());
    return next;
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
   * @returns remoteCanceled 为 false 时，平台任务可能仍会继续并计费；remoteCancelError 有值表示通知平台取消失败（本地取消仍然成功），原因随结果返回给页面提示。
   * @throws NotFoundError 任务不存在或已经结束。
   */
  cancel(rawInput: unknown): Promise<JobCancelResult> {
    return this.dependencies.scheduler.cancel(readEntityId({ id: readRecord(rawInput).jobId }, '任务'));
  }

  /**
   * 读取一个镜头组全部历史成功的版本（视图里每组只带最近若干条任务，版本页需要看到全部）。
   * @param rawInput { workId, episodeId, groupId }。
   * @returns 有结果视频的任务视图，最新的在前。
   * @throws NotFoundError 作品或集不存在、这一集还没有分镜脚本，或镜头组不属于这一集。
   */
  getGroupVersions(rawInput: unknown): JobView[] {
    const { jobs, storyboards } = this.dependencies;
    const source = readRecord(rawInput);
    const groupId = readEntityId({ id: source.groupId }, '镜头组');
    const { run } = this.resolveEpisodeRun(source);
    if (!storyboards.listGroups(run.id).some((group) => group.id === groupId)) {
      throw new NotFoundError('镜头组不存在，可能已被重新分组。');
    }
    const results = new Map(jobs.listResultsByGroups([groupId]).map((result) => [result.jobId, result]));
    return jobs
      .listJobsByGroups([groupId])
      .filter((job) => results.has(job.id))
      .map((job) => this.toJobView(job, results.get(job.id)));
  }

  /**
   * 把某个结果视频设为所在镜头组采用的版本，原来采用的取消。
   * @param rawInput { resultId }。
   * @throws NotFoundError 结果不存在。
   */
  selectResult(rawInput: unknown): { readonly selected: true } {
    const { jobs, changes } = this.dependencies;
    const result = jobs.findResult(readEntityId({ id: readRecord(rawInput).resultId }, '结果'));
    if (result === undefined) {
      throw new NotFoundError('结果视频不存在。');
    }
    if (!result.isSelected) {
      jobs.selectResult(result.id);
      changes.notify({ jobId: result.jobId, groupId: result.groupId, quiet: true });
    }
    return { selected: true };
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

  /** 需要截取尾帧的结果视频：有等待它的任务、但还没有尾帧；工作台据此截取并上传。 */
  listPendingTailFrames(): Array<{ readonly resultId: number }> {
    return this.dependencies.jobs.listResultsAwaitingFrame().map((result) => ({ resultId: result.id }));
  }

  /**
   * 保存工作台从结果视频截取的尾帧，并让等待它的任务继续。
   * @param rawInput { resultId, mimeType, width, height, data（Base64） }。
   * @throws ValidationError 内容不合法。
   * @throws NotFoundError 结果视频不存在。
   */
  saveTailFrame(rawInput: unknown): { readonly saved: true } {
    const { jobs, scheduler } = this.dependencies;
    const input = readTailFrameInput(rawInput);
    const data = Buffer.from(input.dataBase64, 'base64');
    if (data.byteLength === 0 || data.byteLength > TAIL_FRAME_MAX_BYTES) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '尾帧图片内容不合法。' });
    }
    if (jobs.saveResultFrame(input.resultId, { mimeType: input.mimeType, width: input.width, height: input.height, data }, this.timestamp()) === undefined) {
      throw new NotFoundError('结果视频不存在。');
    }
    void scheduler.pump().catch((error: unknown) => console.error('处理生成队列时出现未预期的错误：', error));
    return { saved: true };
  }

  /**
   * 工作台没能从结果视频截取尾帧时，让等待这个结果的任务失败，避免一直等下去。
   * @param rawInput { resultId, reason? }。
   * @returns 被置为失败的任务数。
   */
  reportTailFrameFailure(rawInput: unknown): { readonly failed: number } {
    const { jobs, changes } = this.dependencies;
    const { resultId, reason } = readTailFrameFailure(rawInput);
    const result = jobs.findResult(resultId);
    if (result === undefined) {
      return { failed: 0 };
    }
    const message = reason === '' ? '无法从上一组的视频截取尾帧。' : `无法从上一组的视频截取尾帧：${reason}`;
    let failed = 0;
    for (const job of jobs.listJobsByStatus(['waiting']).filter((candidate) => candidate.prevJobId === result.jobId)) {
      if (jobs.markFailed(job.id, { category: 'invalid_request', code: TAIL_FRAME_UNAVAILABLE_CODE, message }, this.timestamp())) {
        failed += 1;
        changes.notify({ jobId: job.id, groupId: job.groupId });
      }
    }
    return { failed };
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

  /**
   * 解析指定图片首帧：取资产的第一张参考图。
   * @returns 资产图片文件标识；资产或图片不可用时返回说明原因的文字。
   */
  private resolveFirstFrameFile(assetId: number | null): ResolvedFirstFrameImage | string {
    const { assets } = this.dependencies;
    const advice = '请点“编辑镜头”重新选择首帧图片，或把首帧来源改为“无”。';
    if (assetId === null) {
      return `这一组指定了图片作首帧，但指定的资产已被删除。${advice}`;
    }
    const asset = assets.findById(assetId);
    const file = assets.listReferenceFiles(assetId)[0];
    if (asset === undefined || file === undefined) {
      return `这一组指定了“${asset?.name ?? '图片'}”作首帧，但它已没有可用的参考图。${advice}`;
    }
    return { fileId: file.id, width: file.width, height: file.height };
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

  /**
   * 找到这一组首帧依赖的上一组任务：本次提交里刚建的任务，其次是上一组正在进行的任务，最后是上一组已采用的结果。
   * @returns 依赖；上一组什么都没有时返回说明原因的文字。
   */
  private linkPreviousGroup(previous: ShotGroup, createdJobIds: ReadonlyMap<number, number>): FirstFrameLink | string {
    const { jobs } = this.dependencies;
    const created = createdJobIds.get(previous.id);
    if (created !== undefined) {
      return { prevJobId: created, firstFrameId: null };
    }
    const active = jobs.listJobsByGroups([previous.id]).find((job) => ACTIVE_JOB_STATUSES.includes(job.status));
    if (active !== undefined) {
      return { prevJobId: active.id, firstFrameId: null };
    }
    const selected = jobs.listResultsByGroups([previous.id]).find((result) => result.isSelected);
    if (selected !== undefined) {
      return { prevJobId: selected.jobId, firstFrameId: jobs.findResultFrameId(selected.id) ?? null };
    }
    return `上一组（第 ${previous.seq} 组）还没有生成结果，无法用它的尾帧作首帧。请先生成上一组，或点“编辑镜头”把首帧来源改为“无”。`;
  }

  /** 等待前序的任务在等什么：前序还在生成，或前序已完成、等工作台截取尾帧。 */
  private describeWaiting(job: VideoJobRecord): string {
    const previous = job.prevJobId === null ? undefined : this.dependencies.jobs.findJob(job.prevJobId);
    return previous?.status === 'succeeded'
      ? '上一组已生成，正在从视频截取尾帧作首帧（需要保持工作台打开）。'
      : '等待上一组生成完成，再用它的尾帧作首帧。';
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
        audioElements: job.snapshot.params.audioElements ?? null,
        seed: job.snapshot.params.seed
      },
      prompt: job.snapshot.prompt,
      shotCount: job.snapshot.shotIds.length,
      failure: job.failure === null ? null : { ...job.failure, ...describeJobFailure(job.failure) },
      warnings: job.snapshot.warnings,
      usesPreviousTail: job.prevJobId !== null || job.firstFrameId !== null,
      usesFirstFrameImage: job.snapshot.firstFrameFileId != null,
      promptFormat: job.snapshot.promptFormat ?? 1,
      waitNote: job.status === 'waiting' ? this.describeWaiting(job) : null,
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

/** 一个镜头组显示的任务：最新的若干条，并始终包含采用的结果所属的任务（较早的采用版本不能被截断掉）。 */
function pickVisibleJobs(groupJobs: readonly VideoJobRecord[], selectedJobId: number | undefined): VideoJobRecord[] {
  const visible = groupJobs.slice(0, MAX_JOBS_PER_GROUP);
  const selectedJob = groupJobs.find((job) => job.id === selectedJobId);
  return selectedJob === undefined || visible.includes(selectedJob) ? visible : [...visible, selectedJob];
}

/**
 * 采用的视频是用上一组尾帧作首帧生成的，而上一组现在采用的是另一个版本时，返回说明。
 * @param groupJobs 这一组的全部任务。
 * @param selected 这一组采用的结果。
 * @param previousSelected 上一组采用的结果。
 */
function describeStaleTail(groupJobs: readonly VideoJobRecord[], selected: VideoResultRecord | undefined, previousSelected: VideoResultRecord | undefined): string | null {
  const usedJobId = groupJobs.find((job) => job.id === selected?.jobId)?.prevJobId ?? null;
  if (usedJobId === null || previousSelected === undefined || previousSelected.jobId === usedJobId) {
    return null;
  }
  return '上一组后来改用了其他版本，本组采用的视频是接在上一组旧版本的尾帧之后生成的，画面可能不连贯，建议重新生成。';
}

/** 没有已确认的分镜脚本时，说明为什么不能生成。 */
function describeBlockReason(status: string, reviewStatus: string): string {
  if (status === 'running') return '分镜脚本正在生成，完成并确认采用后才能生成视频。';
  if (status === 'failed' || status === 'canceled') return '分镜脚本没有生成成功，请先到“分镜”列表重新生成。';
  if (reviewStatus === 'pending') return '分镜脚本还没有确认采用（修改镜头后需要重新确认）。请点“查看分镜脚本”，确认采用后再生成。';
  return '分镜脚本尚未确认采用。';
}
