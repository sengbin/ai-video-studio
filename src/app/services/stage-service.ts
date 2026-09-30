// ------------------------------------------------------------------------
// 名称：stage-service.ts
// 说明：阶段应用服务：启动创意生成、取消、重试、确认采用、保存人工编辑的章节，并整理阶段产出页需要的视图数据。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：状态流转规则来自 stage-review-rules.ts，本服务只负责组合读写与通知；目前只有创意阶段，剧本与分镜脚本按同样方式扩展。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { ChapterDraft, CreativeParams } from '../../domain/models/creative';
import { StageDisplayStatus, StageKind, StageRun, StageTarget } from '../../domain/models/stage-run';
import { WorkKind, WorkSourceType } from '../../domain/models/work';
import { ChapterRepository } from '../../domain/ports/chapter-repository';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { countWords, normalizeChapterEdit } from '../../domain/rules/creative-rules';
import {
  canApprove,
  canCancel,
  canRetry,
  createApprovalPatch,
  createEditPatch,
  toDisplayStatus
} from '../../domain/rules/stage-review-rules';
import { StageRunner } from '../stages/stage-runner';
import { ChangeNotifier } from './change-notifier';
import { WorkService } from './work-service';

/** 阶段数据变化的载荷：哪个作品的哪条记录变了。 */
export interface StageChange {
  readonly workId: number;
  readonly runId: number;
  readonly stage: StageKind;
}

/** 版本下拉列表中的一项。 */
export interface StageVersionItem {
  readonly id: number;
  readonly version: number;
  readonly display: StageDisplayStatus;
  readonly isCurrent: boolean;
  readonly createdAt: string;
}

/** 章节字数与设定范围的关系：short 少于下限，long 超过上限，null 在范围内。 */
export type ChapterWordHint = 'short' | 'long' | null;

/** 阶段产出页展示的一章。 */
export interface ChapterView extends ChapterDraft {
  readonly wordCount: number;
  readonly wordHint: ChapterWordHint;
}

/** 阶段产出页展示的记录概况。 */
export interface StageRunView {
  readonly id: number;
  readonly version: number;
  readonly display: StageDisplayStatus;
  readonly isCurrent: boolean;
  readonly modelInfo: string | null;
  readonly errorMessage: string | null;
  /** 失败时是否保留了模型原始输出。 */
  readonly hasRawOutput: boolean;
  readonly progress: { readonly step: string; readonly total: number; readonly done: number } | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly approvedAt: string | null;
}

/** 当前记录允许的操作。 */
export interface StageActions {
  readonly canApprove: boolean;
  readonly canCancel: boolean;
  readonly canRetry: boolean;
  /** 是否可以编辑章节：只有最新版本、且生成成功时可编辑。 */
  readonly canEdit: boolean;
  /** 编辑保存后会让已确认的版本回到待确认，保存前需要提示。 */
  readonly editNeedsConfirm: boolean;
}

/** 创意阶段产出页的完整视图。 */
export interface CreativeStageView {
  readonly work: {
    readonly id: number;
    readonly projectId: number;
    readonly name: string;
    readonly kind: WorkKind;
    readonly sourceType: WorkSourceType;
  };
  readonly versions: StageVersionItem[];
  readonly run: StageRunView;
  readonly params: CreativeParams | null;
  readonly chapters: ChapterView[];
  readonly totalWords: number;
  readonly actions: StageActions;
}

/** 阶段应用服务的依赖。 */
export interface StageServiceDependencies {
  readonly works: WorkService;
  readonly runs: StageRunRepository;
  readonly chapters: ChapterRepository;
  readonly runner: StageRunner;
  /** 阶段数据变化的通知器，与执行器共用，页面据此刷新。 */
  readonly changes: ChangeNotifier<StageChange>;
  readonly now?: () => Date;
}

/** 没有正在生成的任务时的提示。 */
const NOT_RUNNING_MESSAGE = '当前没有正在生成的任务。';
/** 只能编辑最新版本时的提示。 */
const NOT_LATEST_MESSAGE = '只能编辑最新版本的产出，请先切换到最新版本。';

/** 阶段应用服务。 */
export class StageService {
  constructor(private readonly dependencies: StageServiceDependencies) {}

  /** 订阅阶段数据变化；返回取消订阅的函数。 */
  onDidChange(listener: (change: StageChange) => void): () => void {
    return this.dependencies.changes.subscribe(listener);
  }

  /**
   * 启动作品的创意生成：新建一个版本，生成在后台执行。
   * @param workId 作品标识。
   * @param rawParams 表单提交的生成参数。
   * @throws NotFoundError 作品不存在。
   * @throws ValidationError 参数不合法或该作品正在生成。
   * @throws TextGenerationError 没有可用的 Copilot 模型。
   */
  async startCreative(workId: number, rawParams: unknown): Promise<StageRun> {
    const work = this.dependencies.works.getWork(workId);
    const run = await this.dependencies.runner.start({
      target: creativeTarget(workId),
      input: { sourceType: work.sourceType, params: rawParams }
    });
    this.publish(run);
    return run;
  }

  /**
   * 读取最近一次创意生成使用的参数，作为“重新生成”表单的初始值。
   * @returns 参数；没有生成记录时为 undefined。
   */
  getLastCreativeParams(workId: number): CreativeParams | undefined {
    const [latest] = this.dependencies.runs.listVersions(creativeTarget(workId));
    return latest === undefined ? undefined : (readParams(latest) ?? undefined);
  }

  /**
   * 整理创意阶段产出页的视图。
   * @param workId 作品标识。
   * @param runId 要查看的版本；缺省为最新版本。
   * @throws NotFoundError 作品或版本不存在，或还没有生成记录。
   */
  getCreativeView(workId: number, runId?: number): CreativeStageView {
    const work = this.dependencies.works.getWork(workId);
    const versions = this.dependencies.runs.listVersions(creativeTarget(workId));
    const latest = versions[0];
    if (latest === undefined) {
      throw new NotFoundError('该作品还没有创意生成记录。');
    }
    const run = runId === undefined ? latest : versions.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new NotFoundError('版本不存在。');
    }

    const params = readParams(run);
    const chapters = this.dependencies.chapters.list(run.id).map((chapter) => toChapterView(chapter, params));
    return {
      work: { id: work.id, projectId: work.projectId, name: work.name, kind: work.kind, sourceType: work.sourceType },
      versions: versions.map(toVersionItem),
      run: toRunView(run),
      params,
      chapters,
      totalWords: chapters.reduce((sum, chapter) => sum + chapter.wordCount, 0),
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
   * 读取失败记录保留的模型原始输出，用于排查。
   * @throws NotFoundError 记录不存在。
   */
  getRawOutput(runId: number): string {
    return this.requireRun(runId).rawOutput ?? '';
  }

  /**
   * 取消正在生成的记录。
   * @throws ValidationError 该记录没有正在执行的生成。
   */
  cancel(runId: number): void {
    if (!this.dependencies.runner.cancel(runId)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NOT_RUNNING_MESSAGE });
    }
  }

  /**
   * 取消作品创意阶段正在进行的生成；没有则什么都不做。删除作品前调用。
   */
  cancelRunningForWork(workId: number): void {
    const running = this.dependencies.runs.findRunning(creativeTarget(workId));
    if (running !== undefined) {
      this.dependencies.runner.cancel(running.id);
    }
  }

  /**
   * 重试失败或已取消的记录：从已保存的进度与章节继续。
   * @throws NotFoundError 记录不存在。
   * @throws ValidationError 记录不是失败或已取消，或已有生成在进行。
   * @throws TextGenerationError 没有可用的 Copilot 模型。
   */
  async retry(runId: number): Promise<void> {
    await this.dependencies.runner.resume(runId);
  }

  /**
   * 确认采用：该版本成为当前版本，原来的当前版本变为历史。
   * @throws NotFoundError 记录不存在。
   * @throws ValidationError 记录不是生成成功且待确认。
   */
  approve(runId: number): void {
    const run = this.requireRun(runId);
    const approved = this.dependencies.runs.approve(run.id, createApprovalPatch(run, this.timestamp()));
    this.publish(approved ?? run);
  }

  /**
   * 保存人工编辑的一章：更新章节，并让该版本回到待确认（修订号加 1）。
   * @throws NotFoundError 记录或章节不存在。
   * @throws ValidationError 内容不合法、不是最新版本或生成尚未成功。
   */
  saveChapter(runId: number, rawChapter: unknown): void {
    const { runs, chapters } = this.dependencies;
    const run = this.requireRun(runId);
    const [latest] = runs.listVersions(run);
    if (latest === undefined || latest.id !== run.id) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NOT_LATEST_MESSAGE });
    }
    const patch = createEditPatch(run);
    const chapter = normalizeChapterEdit(rawChapter);
    if (!chapters.list(run.id).some((saved) => saved.seq === chapter.seq)) {
      throw new NotFoundError(`第 ${chapter.seq} 章不存在。`);
    }

    chapters.save(run.id, chapter, this.timestamp());
    const edited = runs.applyEdit(run.id, patch);
    this.publish(edited ?? run);
  }

  /** 读取记录，不存在时抛出 NotFoundError。 */
  private requireRun(runId: number): StageRun {
    const run = this.dependencies.runs.findById(runId);
    if (run === undefined) {
      throw new NotFoundError('阶段记录不存在。');
    }
    return run;
  }

  private publish(run: StageRun): void {
    this.dependencies.changes.notify({ workId: run.workId, runId: run.id, stage: run.stage });
  }

  private timestamp(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }
}

/** 作品创意阶段的目标。 */
function creativeTarget(workId: number): StageTarget {
  return { workId, stage: 'creative', episodeId: null };
}

/** 从记录的输入快照中取出创意参数；快照结构不符时返回 null。 */
function readParams(run: StageRun): CreativeParams | null {
  const params = (run.input as { params?: unknown }).params;
  return typeof params === 'object' && params !== null ? (params as CreativeParams) : null;
}

function toVersionItem(run: StageRun): StageVersionItem {
  return { id: run.id, version: run.version, display: toDisplayStatus(run), isCurrent: run.isCurrent, createdAt: run.createdAt };
}

function toRunView(run: StageRun): StageRunView {
  return {
    id: run.id,
    version: run.version,
    display: toDisplayStatus(run),
    isCurrent: run.isCurrent,
    modelInfo: run.modelInfo,
    errorMessage: run.errorMessage,
    hasRawOutput: run.rawOutput !== null && run.rawOutput !== '',
    progress: run.progress === null ? null : { step: run.progress.step, total: run.progress.total, done: run.progress.done },
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    approvedAt: run.approvedAt
  };
}

/** 计算章节字数，并与生成参数中的范围比较。 */
function toChapterView(chapter: ChapterDraft, params: CreativeParams | null): ChapterView {
  const wordCount = countWords(chapter.content);
  const wordHint: ChapterWordHint =
    params === null ? null : wordCount < params.chapterMinWords ? 'short' : wordCount > params.chapterMaxWords ? 'long' : null;
  return { ...chapter, wordCount, wordHint };
}
