// ------------------------------------------------------------------------
// 名称：screenplay-service.ts
// 说明：剧本阶段应用服务：启动剧本生成、整理阶段产出页的视图、保存人工编辑的正文、集与实体、重新抽取。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：确认采用时才把抽取结果合并到集和实体（见 StageService.approve）；合并之前编辑的是剧本包上的抽取结果，合并之后编辑的是作品的集和实体本身。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { ENTITY_ATTRIBUTES, ENTITY_KIND_LABELS, EntityKind, ScreenplayParams, ScreenplayStructure } from '../../domain/models/screenplay';
import { StageRun, StageTarget } from '../../domain/models/stage-run';
import { WorkKind, WorkSourceType } from '../../domain/models/work';
import { ScreenplayRepository } from '../../domain/ports/screenplay-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { readRecord } from '../../domain/rules/field-readers';
import {
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
