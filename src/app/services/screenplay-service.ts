// ------------------------------------------------------------------------
// 名称：screenplay-service.ts
// 说明：剧本阶段应用服务：启动剧本生成、整理阶段产出页的视图、保存人工编辑的正文、集与实体，调整集的顺序、重新抽取。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：确认采用时才把抽取结果合并到集和实体（见 StageService.approve）；合并之前编辑的是剧本包上的抽取结果，合并之后编辑的是作品的集和实体本身。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { ENTITY_ATTRIBUTES, ENTITY_KIND_LABELS, EntityKind, EpisodeRecord, ScreenplayParams, ScreenplayStructure } from '../../domain/models/screenplay';
import { StageRun, StageTarget } from '../../domain/models/stage-run';
import { WorkKind, WorkSourceType } from '../../domain/models/work';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { readMoveStep, readRecord } from '../../domain/rules/field-readers';
import {
  MAX_ENTITIES,
  MAX_EPISODES_LIMIT,
  normalizeEntityEdit,
  normalizeEpisodeEdit,
  normalizeScreenplayTextEdit
} from '../../domain/rules/screenplay-rules';
import { canApprove, canCancel, canRetry, createEditPatch, isStale } from '../../domain/rules/stage-review-rules';
import { StageRunner } from '../stages/stage-runner';
import { StageActions, StageRunView, StageService, StageVersionItem, toRunView, toVersionItem } from './stage-service';
import { WorkService } from './work-service';

/** 阶段产出页展示的一集；ref 是编辑时回传的定位值（合并前为抽取结果中的位置，合并后为集的标识）。 */
export interface ScreenplayEpisodeView {
  readonly ref: number;
  readonly seq: number;
  readonly title: string;
  readonly synopsis: string;
  readonly screenplayText: string;
  readonly targetDurationSeconds: number | null;
}

/** 阶段产出页展示的一个实体；ref 含义同集。 */
export interface ScreenplayEntityView {
  readonly ref: number;
  readonly kind: EntityKind;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly isActive: boolean;
}

/** 剧本阶段允许的操作：在通用操作之上多一个重新抽取。 */
export interface ScreenplayActions extends StageActions {
  /** 只有最新版本、生成成功、尚未合并时才能重新抽取。 */
  readonly canReextract: boolean;
}

/** 实体类型及其设定字段的界面说明，页面据此渲染实体编辑表单。 */
export interface EntityKindView {
  readonly kind: EntityKind;
  readonly label: string;
  readonly attributes: ReadonlyArray<{ readonly key: string; readonly label: string }>;
}

/** 剧本阶段产出页的完整视图。 */
export interface ScreenplayStageView {
  readonly work: {
    readonly id: number;
    readonly projectId: number;
    readonly name: string;
    readonly kind: WorkKind;
    readonly sourceType: WorkSourceType;
  };
  readonly versions: StageVersionItem[];
  readonly run: StageRunView;
  readonly params: ScreenplayParams | null;
  /** 剧本包正文；还没有生成时为 null。 */
  readonly screenplay: { readonly title: string; readonly overview: string; readonly fullText: string } | null;
  readonly episodes: ScreenplayEpisodeView[];
  readonly entities: ScreenplayEntityView[];
  readonly entityKinds: EntityKindView[];
  /** 集与实体是否来自作品（已合并到作品，编辑直接改作品的集和实体）。 */
  readonly merged: boolean;
  /** 上游创意已被修改或不再是已确认版本。 */
  readonly stale: boolean;
  /** 下游已有分镜脚本的集序号，确认采用新版本前提示用户它们可能过期。 */
  readonly downstreamEpisodes: number[];
  /** 确认采用这个版本时会被移除的旧集序号：新版本里已不存在、且没有下游数据；已合并的版本为空。 */
  readonly removedEpisodes: number[];
  /** 新版本里已不存在、但已有下游数据的旧集序号：它们存在时确认采用会被拒绝，需先在新版本中保留；已合并的版本为空。 */
  readonly blockedEpisodes: number[];
  readonly actions: ScreenplayActions;
}

/** 剧本阶段应用服务的依赖。 */
export interface ScreenplayServiceDependencies {
  readonly works: WorkService;
  readonly runs: StageRunRepository;
  readonly screenplays: ScreenplayRepository;
  readonly runner: StageRunner;
  /** 阶段服务：提供确认、编辑的通用流程与变化通知。 */
  readonly stages: StageService;
  readonly now?: () => Date;
}

/** 实体类型与设定字段的说明，内容固定，每次视图共用。 */
const ENTITY_KIND_VIEWS: EntityKindView[] = (Object.keys(ENTITY_KIND_LABELS) as EntityKind[]).map((kind) => ({
  kind,
  label: ENTITY_KIND_LABELS[kind],
  attributes: ENTITY_ATTRIBUTES[kind]
}));

/** 剧本阶段应用服务。 */
export class ScreenplayService {
  constructor(private readonly dependencies: ScreenplayServiceDependencies) {}

  /**
   * 检查作品能否开始生成剧本：创意必须已确认。表单打开时先检查，避免用户填完才报错。
   * @throws NotFoundError 作品不存在。
   * @throws ValidationError 创意还没有已确认的版本。
   */
  assertCanStart(workId: number): void {
    this.dependencies.works.getWork(workId);
    if (this.dependencies.runs.findCurrent({ workId, stage: 'creative', episodeId: null }) === undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '请先确认创意。' });
    }
  }

  /**
   * 启动作品的剧本生成：新建一个版本，生成在后台执行。
   * @param workId 作品标识。
   * @param rawParams 表单提交的生成参数。
   * @throws NotFoundError 作品不存在。
   * @throws ValidationError 参数不合法、创意未确认或该作品正在生成剧本。
   * @throws TextGenerationError 没有可用的 Copilot 模型。
   */
  async start(workId: number, rawParams: unknown): Promise<StageRun> {
    const work = this.dependencies.works.getWork(workId);
    const run = await this.dependencies.runner.start({
      target: screenplayTarget(workId),
      input: { workKind: work.kind, workName: work.name, params: rawParams }
    });
    this.dependencies.stages.notifyChanged(run);
    return run;
  }

  /**
   * 读取最近一次剧本生成使用的参数，作为“重新生成”表单的初始值。
   * @returns 参数；没有生成记录时为 undefined。
   */
  getLastParams(workId: number): ScreenplayParams | undefined {
    const [latest] = this.dependencies.runs.listVersions(screenplayTarget(workId));
    return latest === undefined ? undefined : (readParams(latest) ?? undefined);
  }

  /**
   * 统计最新剧本版本的集数与实体数，用于作品列表；合并后按作品的集和实体统计，否则按抽取结果统计。
   * @returns 数量；没有生成成功的剧本或还没有抽取结果时为 null。
   */
  getContentCounts(workId: number): { readonly episodes: number; readonly entities: number } | null {
    const { runs, screenplays } = this.dependencies;
    const [latest] = runs.listVersions(screenplayTarget(workId));
    if (latest === undefined || latest.status !== 'succeeded') {
      return null;
    }
    if (latest.appliedAt !== null) {
      return { episodes: screenplays.listEpisodes(workId).length, entities: screenplays.listEntities(workId).length };
    }
    const structure = screenplays.find(latest.id)?.structure;
    return structure === null || structure === undefined ? null : { episodes: structure.episodes.length, entities: structure.entities.length };
  }

  /**
   * 整理剧本阶段产出页的视图。
   * @param workId 作品标识。
   * @param runId 要查看的版本；缺省为最新版本。
   * @throws NotFoundError 作品或版本不存在，或还没有生成记录。
   */
  getView(workId: number, runId?: number): ScreenplayStageView {
    const { works, runs, screenplays } = this.dependencies;
    const work = works.getWork(workId);
    const versions = runs.listVersions(screenplayTarget(workId));
    const latest = versions[0];
    if (latest === undefined) {
      throw new NotFoundError('该作品还没有剧本生成记录。');
    }
    const run = runId === undefined ? latest : versions.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new NotFoundError('版本不存在。');
    }

    const screenplay = screenplays.find(run.id);
    const merged = run.id === latest.id && run.appliedAt !== null;
    const { episodes, entities } = merged ? this.readMerged(workId) : readStructure(screenplay?.structure ?? null);
    const source = run.sourceRunId === null ? undefined : runs.findById(run.sourceRunId);
    const canEdit = run.id === latest.id && run.status === 'succeeded';
    const removal = run.appliedAt === null ? screenplays.listEpisodesRemovedByMerge(run.id) : [];
    return {
      work: { id: work.id, projectId: work.projectId, name: work.name, kind: work.kind, sourceType: work.sourceType },
      versions: versions.map(toVersionItem),
      run: toRunView(run),
      params: readParams(run),
      screenplay: screenplay === undefined ? null : { title: screenplay.title, overview: screenplay.overview, fullText: screenplay.fullText },
      episodes,
      entities,
      entityKinds: ENTITY_KIND_VIEWS,
      merged,
      stale: run.status === 'succeeded' && isStale(run, source),
      downstreamEpisodes: screenplays
        .listEpisodes(workId)
        .filter((episode) => runs.listVersions({ workId, stage: 'storyboard_script', episodeId: episode.id }).length > 0)
        .map((episode) => episode.seq),
      removedEpisodes: removal.filter((episode) => !episode.hasDownstream).map((episode) => episode.seq),
      blockedEpisodes: removal.filter((episode) => episode.hasDownstream).map((episode) => episode.seq),
      actions: {
        canApprove: canApprove(run),
        canCancel: canCancel(run),
        canRetry: canRetry(run),
        canEdit,
        editNeedsConfirm: run.reviewStatus === 'approved',
        canReextract: canEdit && run.appliedAt === null
      }
    };
  }

  /**
   * 保存人工编辑的剧本包正文，并让该版本回到待确认。已抽取的集和实体不会随正文自动更新，需要时点“重新抽取”。
   * @throws ValidationError 内容不合法、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录不存在或还没有剧本包。
   */
  saveText(runId: number, rawInput: unknown): void {
    const { screenplays } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const fullText = normalizeScreenplayTextEdit(rawInput);
      if (screenplays.find(run.id) === undefined) {
        throw new NotFoundError('剧本包还没有生成。');
      }
      screenplays.updateFullText(run.id, fullText, this.timestamp());
    });
  }

  /**
   * 保存人工编辑的一集，并让该版本回到待确认。
   * @param rawInput { ref, title, synopsis, screenplayText, targetDurationSeconds }，ref 取自视图。
   * @throws ValidationError 内容不合法、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或集不存在。
   */
  saveEpisode(runId: number, rawInput: unknown): void {
    const { screenplays } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const ref = readRef(rawInput);
      const edit = normalizeEpisodeEdit(rawInput);
      if (run.appliedAt !== null) {
        if (!screenplays.updateEpisode(run.workId, ref, edit, this.timestamp())) {
          throw new NotFoundError('集不存在。');
        }
        return;
      }
      const structure = this.requireStructure(run.id);
      const target = structure.episodes[ref];
      if (target === undefined) {
        throw new NotFoundError('集不存在。');
      }
      const episodes = structure.episodes.map((episode, index) => (index === ref ? { ...episode, ...edit } : episode));
      screenplays.saveStructure(run.id, { ...structure, episodes }, this.timestamp());
    });
  }

  /**
   * 保存人工编辑的一个实体，并让该版本回到待确认。
   * @param rawInput { ref, name, aliases, description, attributes, isActive }，ref 取自视图。
   * @throws ValidationError 内容不合法、同类型名称重复、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或实体不存在。
   */
  saveEntity(runId: number, rawInput: unknown): void {
    const { screenplays } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const ref = readRef(rawInput);
      if (run.appliedAt !== null) {
        const current = screenplays.listEntities(run.workId).find((entity) => entity.id === ref);
        if (current === undefined) {
          throw new NotFoundError('实体不存在。');
        }
        screenplays.updateEntity(run.workId, ref, normalizeEntityEdit(rawInput, current.kind), this.timestamp());
        return;
      }

      const structure = this.requireStructure(run.id);
      const target = structure.entities[ref];
      if (target === undefined) {
        throw new NotFoundError('实体不存在。');
      }
      const edit = normalizeEntityEdit(rawInput, target.kind);
      if (structure.entities.some((entity, index) => index !== ref && entity.kind === target.kind && entity.name === edit.name)) {
        throw new ValidationError({ name: '同类型下已有同名实体，请换一个名称。' });
      }
      const entities = structure.entities.map((entity, index) => (index === ref ? { ...entity, ...edit } : entity));
      screenplays.saveStructure(run.id, { ...structure, entities }, this.timestamp());
    });
  }

  /**
   * 在末尾新增一集，并让该版本回到待确认；单个短视频只有 1 集，不能新增。
   * @param rawInput { title, synopsis, screenplayText, targetDurationSeconds }。
   * @returns 新集的定位值（视图中的 ref）。
   * @throws ValidationError 内容不合法、单个短视频、集数已达上限、不是最新版本或生成尚未成功。
   */
  addEpisode(runId: number, rawInput: unknown): number {
    const { screenplays } = this.dependencies;
    let ref = -1;
    this.dependencies.stages.editLatest(runId, (run) => {
      this.assertSeries(run.workId, '新增');
      const edit = normalizeEpisodeEdit(rawInput);
      if (run.appliedAt !== null) {
        this.assertBelowLimit(screenplays.listEpisodes(run.workId).length, MAX_EPISODES_LIMIT, '集');
        ref = screenplays.insertEpisode(run.workId, edit, this.timestamp());
        return;
      }
      const structure = this.requireStructure(run.id);
      this.assertBelowLimit(structure.episodes.length, MAX_EPISODES_LIMIT, '集');
      ref = structure.episodes.length;
      const episodes = [...structure.episodes, { seq: ref + 1, ...edit }];
      screenplays.saveStructure(run.id, { ...structure, episodes }, this.timestamp());
    });
    return ref;
  }

  /**
   * 删除一集，并让该版本回到待确认；后面的集序号依次前移。已合并的集连同它的分镜脚本一起删除。
   * @param rawInput { ref }，ref 取自视图。
   * @throws ValidationError 单个短视频、只剩最后一集、这一集正在生成分镜脚本、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或集不存在。
   */
  deleteEpisode(runId: number, rawInput: unknown): void {
    const { screenplays, runs } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const ref = readRef(rawInput);
      this.assertSeries(run.workId, '删除');
      if (run.appliedAt !== null) {
        const episodes = screenplays.listEpisodes(run.workId);
        if (!episodes.some((episode) => episode.id === ref)) {
          throw new NotFoundError('集不存在。');
        }
        this.assertKeepsOneEpisode(episodes.length);
        if (runs.findRunning({ workId: run.workId, stage: 'storyboard_script', episodeId: ref }) !== undefined) {
          throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '这一集正在生成分镜脚本，请等待完成或先取消。' });
        }
        screenplays.deleteEpisode(run.workId, ref);
        return;
      }
      const structure = this.requireStructure(run.id);
      if (structure.episodes[ref] === undefined) {
        throw new NotFoundError('集不存在。');
      }
      this.assertKeepsOneEpisode(structure.episodes.length);
      const episodes = structure.episodes.filter((_, index) => index !== ref).map((episode, index) => ({ ...episode, seq: index + 1 }));
      screenplays.saveStructure(run.id, { ...structure, episodes }, this.timestamp());
    });
  }

  /**
   * 把一集与前一集或后一集互换位置，并让该版本回到待确认。已合并的集只互换序号，分镜脚本、绑定等下游数据跟着集走；尚未合并的互换抽取结果中的位置。
   * @param rawInput { ref, direction }，ref 取自视图，direction 为 'up' 或 'down'。
   * @returns 被移动的集的新定位值（已合并时不变，未合并时为新的位置）。
   * @throws ValidationError 方向不合法、单个短视频、已经在最前或最后、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或集不存在。
   */
  moveEpisode(runId: number, rawInput: unknown): number {
    const { screenplays } = this.dependencies;
    let newRef = -1;
    this.dependencies.stages.editLatest(runId, (run) => {
      const step = readMoveStep(readRecord(rawInput));
      const ref = readRef(rawInput);
      this.assertSeries(run.workId, '调整');
      const boundary = step < 0 ? '已经是第一集，不能再前移。' : '已经是最后一集，不能再后移。';
      if (run.appliedAt !== null) {
        const episodes = screenplays.listEpisodes(run.workId);
        const index = episodes.findIndex((episode) => episode.id === ref);
        if (index < 0) {
          throw new NotFoundError('集不存在。');
        }
        const other = episodes[index + step] as EpisodeRecord | undefined;
        if (other === undefined) {
          throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: boundary });
        }
        screenplays.swapEpisodes(run.workId, ref, other.id, this.timestamp());
        newRef = ref;
        return;
      }
      const structure = this.requireStructure(run.id);
      if (structure.episodes[ref] === undefined) {
        throw new NotFoundError('集不存在。');
      }
      if (structure.episodes[ref + step] === undefined) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: boundary });
      }
      const reordered = [...structure.episodes];
      [reordered[ref], reordered[ref + step]] = [reordered[ref + step], reordered[ref]];
      screenplays.saveStructure(run.id, { ...structure, episodes: reordered.map((episode, index) => ({ ...episode, seq: index + 1 })) }, this.timestamp());
      newRef = ref + step;
    });
    return newRef;
  }

  /**
   * 新增一个实体，并让该版本回到待确认。
   * @param rawInput { kind, name, aliases, description, attributes, isActive }。
   * @returns 新实体的定位值（视图中的 ref）。
   * @throws ValidationError 内容不合法、同类型名称重复、实体数已达上限、不是最新版本或生成尚未成功。
   */
  addEntity(runId: number, rawInput: unknown): number {
    const { screenplays } = this.dependencies;
    let ref = -1;
    this.dependencies.stages.editLatest(runId, (run) => {
      const kind = readRecord(rawInput).kind;
      if (typeof kind !== 'string' || !Object.keys(ENTITY_KIND_LABELS).includes(kind)) {
        throw new ValidationError({ kind: '请选择实体类型。' });
      }
      const edit = normalizeEntityEdit(rawInput, kind as EntityKind);
      if (run.appliedAt !== null) {
        this.assertBelowLimit(screenplays.listEntities(run.workId).length, MAX_ENTITIES, '实体');
        ref = screenplays.insertEntity(run.workId, kind as EntityKind, edit, this.timestamp());
        return;
      }
      const structure = this.requireStructure(run.id);
      this.assertBelowLimit(structure.entities.length, MAX_ENTITIES, '实体');
      if (structure.entities.some((entity) => entity.kind === kind && entity.name === edit.name)) {
        throw new ValidationError({ name: '同类型下已有同名实体，请换一个名称。' });
      }
      ref = structure.entities.length;
      const entities = [...structure.entities, { kind: kind as EntityKind, ...edit }];
      screenplays.saveStructure(run.id, { ...structure, entities }, this.timestamp());
    });
    return ref;
  }

  /**
   * 删除一个实体，并让该版本回到待确认。已合并的实体被镜头、镜头声音或资产绑定引用时不能删除，应改为停用。
   * @param rawInput { ref }，ref 取自视图。
   * @throws ValidationError 实体仍被引用、不是最新版本或生成尚未成功。
   * @throws NotFoundError 记录或实体不存在。
   */
  deleteEntity(runId: number, rawInput: unknown): void {
    const { screenplays } = this.dependencies;
    this.dependencies.stages.editLatest(runId, (run) => {
      const ref = readRef(rawInput);
      if (run.appliedAt !== null) {
        const entity = screenplays.listEntities(run.workId).find((candidate) => candidate.id === ref);
        if (entity === undefined) {
          throw new NotFoundError('实体不存在。');
        }
        const references = screenplays.countEntityReferences(ref);
        if (references > 0) {
          throw new ValidationError({
            [FORM_LEVEL_ERROR_KEY]: `实体“${entity.name}”已被 ${references} 处引用（镜头、声音或资产绑定），不能删除；如不再使用，可改为停用。`
          });
        }
        screenplays.deleteEntity(run.workId, ref);
        return;
      }
      const structure = this.requireStructure(run.id);
      if (structure.entities[ref] === undefined) {
        throw new NotFoundError('实体不存在。');
      }
      const entities = structure.entities.filter((_, index) => index !== ref);
      screenplays.saveStructure(run.id, { ...structure, entities }, this.timestamp());
    });
  }

  /**
   * 用当前剧本包正文重新抽取集和实体，覆盖尚未合并的抽取结果；在后台执行，进度通过阶段事件推送。
   * @throws NotFoundError 记录不存在。
   * @throws ValidationError 不是最新版本、生成尚未成功或抽取结果已合并到作品。
   * @throws TextGenerationError 没有可用的 Copilot 模型。
   */
  async reextract(runId: number): Promise<void> {
    const { runs, screenplays, runner, stages } = this.dependencies;
    const run = stages.requireRun(runId);
    const [latest] = runs.listVersions(run);
    if (latest === undefined || latest.id !== run.id) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '只能对最新版本重新抽取，请先切换到最新版本。' });
    }
    if (run.appliedAt !== null) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '集和实体已经合并到作品，不能重新抽取；如需更新，请重新生成剧本。' });
    }
    const patch = createEditPatch(run);
    await runner.reextract(run.id, () => {
      screenplays.clearStructure(run.id, this.timestamp());
      runs.applyEdit(run.id, patch);
    });
  }

  /** 读取作品已合并的集和实体，ref 为数据库标识。 */
  private readMerged(workId: number): { episodes: ScreenplayEpisodeView[]; entities: ScreenplayEntityView[] } {
    const { screenplays } = this.dependencies;
    return {
      episodes: screenplays.listEpisodes(workId).map((episode) => ({ ref: episode.id, ...episode })),
      entities: screenplays.listEntities(workId).map((entity) => ({ ref: entity.id, ...entity }))
    };
  }

  /** 读取尚未合并的抽取结果；还没有抽取时抛出 NotFoundError。 */
  private requireStructure(runId: number): ScreenplayStructure {
    const structure = this.dependencies.screenplays.find(runId)?.structure;
    if (structure === null || structure === undefined) {
      throw new NotFoundError('还没有抽取集和实体。');
    }
    return structure;
  }

  /** 单个短视频只有 1 集，不允许增删集。 */
  private assertSeries(workId: number, action: string): void {
    if (this.dependencies.works.getWork(workId).kind === 'single') {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `单个短视频只有 1 集，不能${action}集。` });
    }
  }

  /** 数量已达上限时不能再新增。 */
  private assertBelowLimit(count: number, limit: number, label: string): void {
    if (count >= limit) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `${label}数量已达上限 ${limit}，不能再新增。` });
    }
  }

  /** 至少保留 1 集，不能删到只剩零集。 */
  private assertKeepsOneEpisode(count: number): void {
    if (count <= 1) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '至少保留 1 集，不能删除。' });
    }
  }

  private timestamp(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

/** 作品剧本阶段的目标。 */
function screenplayTarget(workId: number): StageTarget {
  return { workId, stage: 'screenplay', episodeId: null };
}

/** 从记录的输入快照中取出剧本参数；快照结构不符时返回 null。 */
function readParams(run: StageRun): ScreenplayParams | null {
  const params = (run.input as { params?: unknown }).params;
  return typeof params === 'object' && params !== null ? (params as ScreenplayParams) : null;
}

/** 抽取结果转视图，ref 为在抽取结果中的位置；没有抽取结果时为空。 */
function readStructure(structure: ScreenplayStructure | null): { episodes: ScreenplayEpisodeView[]; entities: ScreenplayEntityView[] } {
  return {
    episodes: (structure?.episodes ?? []).map((episode, index) => ({ ref: index, ...episode })),
    entities: (structure?.entities ?? []).map((entity, index) => ({ ref: index, ...entity }))
  };
}

/** 读取请求中的定位值：非负整数。 */
function readRef(rawInput: unknown): number {
  const ref = readRecord(rawInput).ref;
  if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '定位信息无效。' });
  }
  return ref;
}
