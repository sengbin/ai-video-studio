// ------------------------------------------------------------------------
// 名称：storyboard-service.ts
// 说明：分镜脚本阶段应用服务：为一集或多集启动生成、整理阶段产出页的视图与各集状态、保存人工编辑的镜头，新增、删除镜头并调整镜头顺序。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：每一集一条阶段记录（目标含集标识）；产出直接写入镜头表，确认采用只改阶段记录状态；上游是已确认的剧本。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { ENTITY_KIND_LABELS, EntityKind, EpisodeRecord } from '../../domain/models/screenplay';
import { SOUND_KIND_LABELS, ShotRecord, SoundKind, StoryboardEntity, StoryboardParams } from '../../domain/models/storyboard';
import { StageDisplayStatus, StageRun, StageTarget } from '../../domain/models/stage-run';
import { WorkKind, WorkSourceType } from '../../domain/models/work';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { readMoveStep, readRecord } from '../../domain/rules/field-readers';
import { canApprove, canCancel, canRetry, isStale, toDisplayStatus } from '../../domain/rules/stage-review-rules';
import { MAX_SHOTS_LIMIT, normalizeShotEdit, normalizeStoryboardParams } from '../../domain/rules/storyboard-rules';
import { groupMaxSecondsOf, sumSeconds } from '../../domain/rules/shot-group-rules';
import { StageRunner } from '../stages/stage-runner';
import { ProjectService } from './project-service';
import { syncShotGroups } from './shot-grouping';
import { StageActions, StageRunView, StageService, StageVersionItem, toRunView, toVersionItem } from './stage-service';
import { WorkService } from './work-service';

/** 一集的分镜脚本状态，用于作品列表与“生成分镜脚本”表单。 */
export interface EpisodeStoryboardStatus {
  readonly episodeId: number;
  readonly seq: number;
  readonly title: string;
  /** 最新版本的展示状态；还没有生成记录时为 none。 */
  readonly display: StageDisplayStatus | 'none';
  readonly runId: number | null;
  readonly version: number | null;
  /** 生成中的进度文字；没有进度时为 null。 */
  readonly progressText: string | null;
  /** 上游剧本已被修改或不再是已确认版本，本产出可能已过期。 */
  readonly stale: boolean;
  /** 最新版本已写入的镜头数。 */
  readonly shotCount: number;
}

/** 作品列表中的分镜脚本汇总。 */
export interface StoryboardSummary {
  /** 剧本已确认，可以生成分镜脚本。 */
  readonly canStart: boolean;
  /** 集的总数（剧本已合并的集）。 */
  readonly episodes: number;
  /** 最新版本已确认的集数。 */
  readonly approved: number;
  /** 已有生成记录的集数。 */
  readonly started: number;
}

/** 阶段产出页展示的实体：用于选择出场实体与说话人。 */
export interface StoryboardEntityView {
  readonly id: number;
  readonly kind: EntityKind;
  readonly kindLabel: string;
  readonly name: string;
  readonly isActive: boolean;
}

/** 分镜脚本阶段产出页展示的镜头组：组序号、组内镜头与总时长。 */
export interface StoryboardGroupView {
  readonly id: number;
  readonly seq: number;
  readonly shotIds: readonly number[];
  readonly totalSeconds: number;
}

/** 分镜脚本阶段产出页的完整视图。 */
export interface StoryboardStageView {
  readonly work: {
    readonly id: number;
    readonly projectId: number;
    readonly name: string;
    readonly kind: WorkKind;
    readonly sourceType: WorkSourceType;
  };
  readonly episode: { readonly id: number; readonly seq: number; readonly title: string };
  readonly versions: StageVersionItem[];
  readonly run: StageRunView;
  readonly params: StoryboardParams | null;
  readonly shots: ShotRecord[];
  /** 相邻镜头打包成的镜头组（一组一次生成一个视频），按组序号排列。 */
  readonly groups: StoryboardGroupView[];
  /** 单组最长时长（秒），生成分镜脚本时设定。 */
  readonly groupMaxSeconds: number;
  /** 全部镜头时长之和（秒）。 */
  readonly totalSeconds: number;
  readonly entities: StoryboardEntityView[];
  readonly soundKinds: ReadonlyArray<{ readonly kind: SoundKind; readonly label: string }>;
  /** 上游剧本已被修改或不再是已确认版本。 */
  readonly stale: boolean;
  readonly actions: StageActions;
}

/** 分镜脚本应用服务的依赖。 */
export interface StoryboardServiceDependencies {
  readonly works: WorkService;
  readonly projects: ProjectService;
  readonly runs: StageRunRepository;
  readonly screenplays: ScreenplayRepository;
  readonly storyboards: StoryboardRepository;
  readonly runner: StageRunner;
  /** 阶段服务：提供编辑的通用流程与变化通知。 */
  readonly stages: StageService;
  readonly now?: () => Date;
}

const SOUND_KIND_VIEWS = (Object.keys(SOUND_KIND_LABELS) as SoundKind[]).map((kind) => ({ kind, label: SOUND_KIND_LABELS[kind] }));

/** 分镜脚本应用服务。 */
export class StoryboardService {
  constructor(private readonly dependencies: StoryboardServiceDependencies) {}

  /**
   * 检查作品能否开始生成分镜脚本：剧本必须已确认，且已有集。表单打开时先检查，避免用户填完才报错。
   * @throws NotFoundError 作品不存在。
   * @throws ValidationError 剧本还没有已确认的版本，或还没有集。
   */
  assertCanStart(workId: number): void {
    const { works, runs, screenplays } = this.dependencies;
    works.getWork(workId);
    if (runs.findCurrent({ workId, stage: 'screenplay', episodeId: null }) === undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '请先确认剧本。' });
    }
    if (screenplays.listEpisodes(workId).length === 0) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '剧本里还没有集，请先确认剧本。' });
    }
  }

  /** 列出作品各集的分镜脚本状态，按集序号升序；作品还没有集时为空。 */
  listEpisodeStatuses(workId: number): EpisodeStoryboardStatus[] {
    const { screenplays } = this.dependencies;
    return screenplays.listEpisodes(workId).map((episode) => this.describeEpisode(workId, episode));
  }

  /** 汇总作品的分镜脚本进度，用于作品列表。 */
  getSummary(workId: number): StoryboardSummary {
    const statuses = this.listEpisodeStatuses(workId);
    const canStart = this.dependencies.runs.findCurrent({ workId, stage: 'screenplay', episodeId: null }) !== undefined;
    return {
      canStart,
      episodes: statuses.length,
      approved: statuses.filter((status) => status.display === 'approved').length,
      started: statuses.filter((status) => status.display !== 'none').length
    };
  }

  /**
   * 为一集或多集启动分镜脚本生成：每集新建一个版本，生成在后台并行执行。
   * @param workId 作品标识。
   * @param episodeIds 集标识；必须属于该作品且不重复，至少一集。
   * @param rawParams 表单提交的生成参数。
   * @throws NotFoundError 作品不存在。
   * @throws ValidationError 参数不合法、集不属于作品、剧本未确认或某一集正在生成。
   * @throws TextGenerationError 没有可用的 Copilot 模型。
   */
  async start(workId: number, episodeIds: readonly number[], rawParams: unknown): Promise<StageRun[]> {
    const { works, projects, screenplays, runs, runner, stages } = this.dependencies;
    const work = works.getWork(workId);
    this.assertCanStart(workId);
    const ids = [...new Set(episodeIds)];
    if (ids.length === 0) {
      throw new ValidationError({ episodeId: '请选择要生成的集。' });
    }
    const episodes = new Set(screenplays.listEpisodes(workId).map((episode) => episode.id));
    if (ids.some((id) => !episodes.has(id))) {
      throw new ValidationError({ episodeId: '所选的集不属于该作品。' });
    }
    // 先校验参数并检查没有正在生成的集，避免启动了一部分才失败。
    normalizeStoryboardParams(rawParams);
    if (ids.some((id) => runs.findRunning(storyboardTarget(workId, id)) !== undefined)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '所选的集里有正在生成的分镜脚本，请等待完成或先取消。' });
    }

    const projectStyle = projects.getProject(work.projectId).visualStyle;
    const started: StageRun[] = [];
    for (const episodeId of ids) {
      const run = await runner.start({
        target: storyboardTarget(workId, episodeId),
        input: { workName: work.name, projectStyle, params: rawParams }
      });
      stages.notifyChanged(run);
      started.push(run);
    }
    return started;
  }

  /**
   * 读取作品最近一次分镜脚本生成使用的参数，作为表单与“重新生成”的初始值。
   * @param episodeId 指定集时只看这一集；缺省看作品所有集中最近的一次。
   * @returns 参数；没有生成记录时为 undefined。
   */
  getLastParams(workId: number, episodeId?: number): StoryboardParams | undefined {
    const { runs, screenplays } = this.dependencies;
    const ids = episodeId === undefined ? screenplays.listEpisodes(workId).map((episode) => episode.id) : [episodeId];
    const latest = ids
      .flatMap((id) => runs.listVersions(storyboardTarget(workId, id)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id - left.id)[0];
    return latest === undefined ? undefined : (readStoryboardParams(latest) ?? undefined);
  }

  /**
   * 整理分镜脚本阶段产出页的视图。
   * @param workId 作品标识。
   * @param episodeId 集标识。
   * @param runId 要查看的版本；缺省为最新版本。
   * @throws NotFoundError 作品、集或版本不存在，或这一集还没有生成记录。
   */
  getView(workId: number, episodeId: number, runId?: number): StoryboardStageView {
    const { works, runs, screenplays, storyboards } = this.dependencies;
    const work = works.getWork(workId);
    const episode = screenplays.listEpisodes(workId).find((candidate) => candidate.id === episodeId);
    if (episode === undefined) {
      throw new NotFoundError('集不存在。');
    }
    const versions = runs.listVersions(storyboardTarget(workId, episodeId));
    const latest = versions[0];
    if (latest === undefined) {
      throw new NotFoundError('这一集还没有分镜脚本生成记录。');
    }
    const run = runId === undefined ? latest : versions.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new NotFoundError('版本不存在。');
    }

    const groupMaxSeconds = groupMaxSecondsOf(readStoryboardParams(run));
    // 生成成功的版本读取时补全分组（旧数据没有分组）。
    if (run.status === 'succeeded') syncShotGroups(storyboards, run.id, groupMaxSeconds, this.timestamp());
    const shots = storyboards.listShots(run.id);
    const shotById = new Map(shots.map((shot) => [shot.id, shot]));
    const source = run.sourceRunId === null ? undefined : runs.findById(run.sourceRunId);
    return {
      work: { id: work.id, projectId: work.projectId, name: work.name, kind: work.kind, sourceType: work.sourceType },
      episode: { id: episode.id, seq: episode.seq, title: episode.title },
      versions: versions.map(toVersionItem),
      run: toRunView(run),
      params: readStoryboardParams(run),
      shots,
      groups: storyboards.listGroups(run.id).map((group) => ({
        id: group.id,
        seq: group.seq,
        shotIds: group.shotIds,
        totalSeconds: sumSeconds(group.shotIds.flatMap((id) => shotById.get(id) ?? []))
      })),
      groupMaxSeconds,
      totalSeconds: Math.round(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) * 10) / 10,
      entities: screenplays.listEntities(workId).map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        kindLabel: ENTITY_KIND_LABELS[entity.kind],
        name: entity.name,
        isActive: entity.isActive
      })),
      soundKinds: SOUND_KIND_VIEWS,
      stale: run.status === 'succeeded' && isStale(run, source),
      actions: {
        canApprove: canApprove(run),
        canCancel: canCancel(run),
        canRetry: canRetry(run),
        canEdit: run.id === latest.id && run.status === 'succeeded',
        editNeedsConfirm: run.reviewStatus === 'approved'
      }
    };
  }

  /**
   * 保存人工编辑的一个镜头（含出场实体与声音），并让该版本回到待确认。
   * @param rawInput { ref, ...镜头字段 }，ref 为视图中的镜头标识。
   * @throws ValidationError 内容不合法、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或镜头不存在。
   */
  saveShot(runId: number, rawInput: unknown): void {
    const { screenplays, storyboards } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const source = readRecord(rawInput);
      const ref = source.ref;
      const shots = storyboards.listShots(run.id);
      const shot = shots.find((candidate) => candidate.id === ref);
      if (shot === undefined) {
        throw new NotFoundError('镜头不存在。');
      }
      const entities: StoryboardEntity[] = screenplays
        .listEntities(run.workId)
        .map(({ id, kind, name, aliases }) => ({ id, kind, name, aliases }));
      const edit = normalizeShotEdit(rawInput, entities, shot.seq === 1);
      if (!storyboards.updateShot(run.id, shot.id, edit, this.timestamp())) {
        throw new NotFoundError('镜头不存在。');
      }
    });
  }

  /**
   * 在末尾新增一个镜头（含出场实体与声音），并让该版本回到待确认。
   * @param rawInput 镜头字段，同 saveShot（不带 ref）。
   * @returns 新镜头的标识。
   * @throws ValidationError 内容不合法、镜头数已达上限、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录不存在或还没有分镜脚本。
   */
  addShot(runId: number, rawInput: unknown): number {
    const { screenplays, storyboards } = this.dependencies;
    let shotId = -1;
    this.dependencies.stages.editLatest(runId, (run) => {
      if (storyboards.find(run.id) === undefined) {
        throw new NotFoundError('分镜脚本还没有生成。');
      }
      const count = storyboards.countShots(run.id);
      if (count >= MAX_SHOTS_LIMIT) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `镜头数量已达上限 ${MAX_SHOTS_LIMIT}，不能再新增。` });
      }
      const entities: StoryboardEntity[] = screenplays
        .listEntities(run.workId)
        .map(({ id, kind, name, aliases }) => ({ id, kind, name, aliases }));
      const edit = normalizeShotEdit(rawInput, entities, count === 0);
      shotId = storyboards.insertShot(run.id, edit, this.timestamp());
      syncShotGroups(storyboards, run.id, groupMaxSecondsOf(readStoryboardParams(run)), this.timestamp());
    });
    return shotId;
  }

  /**
   * 删除一个镜头，并让该版本回到待确认；后面的镜头序号依次前移。
   * @param rawInput { ref }，ref 为视图中的镜头标识。
   * @throws ValidationError 只剩最后一个镜头、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或镜头不存在。
   */
  deleteShot(runId: number, rawInput: unknown): void {
    const { storyboards } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const ref = readRecord(rawInput).ref;
      const shots = storyboards.listShots(run.id);
      if (!shots.some((candidate) => candidate.id === ref)) {
        throw new NotFoundError('镜头不存在。');
      }
      if (shots.length <= 1) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '至少保留 1 个镜头，不能删除。' });
      }
      if (!storyboards.deleteShot(run.id, ref as number, this.timestamp())) {
        throw new NotFoundError('镜头不存在。');
      }
      syncShotGroups(storyboards, run.id, groupMaxSecondsOf(readStoryboardParams(run)), this.timestamp());
    });
  }

  /**
   * 把一个镜头与前一个或后一个镜头互换位置（序号和所在的镜头组一起互换，各组镜头数不变），并让该版本回到待确认。
   * @param rawInput { ref, direction }，ref 为视图中的镜头标识，direction 为 'up'（前移）或 'down'（后移）。
   * @throws ValidationError 方向不合法、已经在最前或最后、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或镜头不存在。
   */
  moveShot(runId: number, rawInput: unknown): void {
    const { storyboards } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const source = readRecord(rawInput);
      const step = readMoveStep(source);
      const shots = storyboards.listShots(run.id);
      const index = shots.findIndex((candidate) => candidate.id === source.ref);
      if (index < 0) {
        throw new NotFoundError('镜头不存在。');
      }
      const other = shots[index + step] as ShotRecord | undefined;
      if (other === undefined) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: step < 0 ? '已经是第一个镜头，不能再前移。' : '已经是最后一个镜头，不能再后移。' });
      }
      if (!storyboards.swapShots(run.id, shots[index].id, other.id, this.timestamp())) {
        throw new NotFoundError('镜头不存在。');
      }
      syncShotGroups(storyboards, run.id, groupMaxSecondsOf(readStoryboardParams(run)), this.timestamp());
    });
  }

  /** 一集的状态：取最新版本。 */
  private describeEpisode(workId: number, episode: EpisodeRecord): EpisodeStoryboardStatus {
    const { runs, storyboards } = this.dependencies;
    const [latest] = runs.listVersions(storyboardTarget(workId, episode.id));
    if (latest === undefined) {
      return {
        episodeId: episode.id,
        seq: episode.seq,
        title: episode.title,
        display: 'none',
        runId: null,
        version: null,
        progressText: null,
        stale: false,
        shotCount: 0
      };
    }
    const source = latest.sourceRunId === null ? undefined : runs.findById(latest.sourceRunId);
    return {
      episodeId: episode.id,
      seq: episode.seq,
      title: episode.title,
      display: toDisplayStatus(latest),
      runId: latest.id,
      version: latest.version,
      progressText: latest.status === 'running' && latest.progress !== null ? `${latest.progress.done} / ${latest.progress.total}` : null,
      stale: latest.status === 'succeeded' && isStale(latest, source),
      shotCount: storyboards.countShots(latest.id)
    };
  }

  private timestamp(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

/** 一集分镜脚本阶段的目标。 */
export function storyboardTarget(workId: number, episodeId: number): StageTarget {
  return { workId, stage: 'storyboard_script', episodeId };
}

/** 从记录的输入快照中取出分镜脚本参数；快照结构不符时返回 null。 */
export function readStoryboardParams(run: StageRun): StoryboardParams | null {
  const params = (run.input as { params?: unknown }).params;
  return typeof params === 'object' && params !== null ? (params as StoryboardParams) : null;
}
