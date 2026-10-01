// ------------------------------------------------------------------------
// 名称：work-service.ts
// 说明：作品应用服务：列出项目或某种素材来源下的作品及其创意、剧本阶段状态、检查名称唯一、创建、修改与删除作品，变化后通知订阅者。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code 和具体存储；输入校验由领域规则完成，创建作品接收已规范化的内容，时钟可注入以便测试。
// ------------------------------------------------------------------------

import { ConflictError, NotFoundError } from '../../domain/errors';
import { StageDisplayStatus, StageKind, StageRun } from '../../domain/models/stage-run';
import { NewWorkSource, Work, WorkKind, WorkSourceType } from '../../domain/models/work';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { WorkRepository } from '../../domain/ports/work-repository';
import { isStale, toDisplayStatus } from '../../domain/rules/stage-review-rules';
import { NormalizedWorkCreation, normalizeWorkUpdate } from '../../domain/rules/work-rules';
import { ChangeNotifier } from './change-notifier';

/** 作品名称重复时的错误提示。 */
export const DUPLICATE_WORK_NAME_MESSAGE = '该项目内已存在同名作品，请换一个名称。';

/** 阶段状态摘要：没有生成记录时为 none。 */
export interface StageStatusSummary {
  readonly display: StageDisplayStatus | 'none';
  readonly runId: number | null;
  readonly version: number | null;
  /** 生成中的进度文字，如“3 / 12”；没有进度时为 null。 */
  readonly progressText: string | null;
  /** 上游产出已被修改或不再是已确认版本，本阶段产出可能已过期。 */
  readonly stale: boolean;
}

/** 作品列表中的一行：作品及其创意、剧本阶段状态。 */
export interface WorkListItem {
  readonly id: number;
  readonly projectId: number;
  readonly name: string;
  readonly kind: WorkKind;
  readonly sourceType: WorkSourceType;
  readonly createdAt: string;
  readonly creative: StageStatusSummary;
  readonly screenplay: StageStatusSummary;
  /** 创意已确认，可以开始生成剧本。 */
  readonly canStartScreenplay: boolean;
}

/** 作品应用服务。 */
export class WorkService {
  /** 变化通知的载荷是发生变化的项目标识。 */
  private readonly changeNotifier = new ChangeNotifier<number>();

  /**
   * @param works 作品仓库。
   * @param runs 阶段记录仓库，用于读取作品的创意阶段状态。
   * @param now 返回当前时间的函数，测试时可注入固定时间。
   */
  constructor(
    private readonly works: WorkRepository,
    private readonly runs: StageRunRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** 订阅作品数据变化；返回取消订阅的函数。 */
  onDidChangeWorks(listener: (projectId: number) => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }

  /** 列出项目下的作品及其创意阶段状态。 */
  listWorks(projectId: number): WorkListItem[] {
    return this.works.listByProject(projectId).map((work) => this.toListItem(work));
  }

  /** 列出所有项目中指定素材来源的作品及其创意阶段状态。 */
  listWorksBySource(sourceType: WorkSourceType): WorkListItem[] {
    return this.works.listBySource(sourceType).map((work) => this.toListItem(work));
  }

  /** 列出所有项目、所有素材来源的作品及其阶段状态。 */
  listAllWorks(): WorkListItem[] {
    return this.works.listAll().map((work) => this.toListItem(work));
  }

  /** 按标识查找作品；不存在返回 undefined。 */
  findWork(id: number): Work | undefined {
    return this.works.findById(id);
  }

  /**
   * 读取作品。
   * @throws NotFoundError 作品不存在。
   */
  getWork(id: number): Work {
    const work = this.works.findById(id);
    if (work === undefined) {
      throw new NotFoundError(`作品 ${id} 不存在。`);
    }
    return work;
  }

  /**
   * 判断作品名称在项目内是否可用，用于表单在字段失去焦点时检查重名。
   * @param excludeWorkId 修改作品时排除自身。
   */
  isWorkNameAvailable(projectId: number, name: string, excludeWorkId?: number): boolean {
    const existing = this.works.findByName(projectId, name.trim());
    return existing === undefined || existing.id === excludeWorkId;
  }

  /** 作品形态是否还能修改：剧本一旦确认过，集就已经按剧情确定，形态不再能改。 */
  canChangeKind(workId: number): boolean {
    return this.runs.listVersions({ workId, stage: 'screenplay', episodeId: null }).every((run) => run.approvedAt === null);
  }

  /** 按上传顺序读取作品的灵感图片，供编辑表单带出已有图片。 */
  listImageSources(workId: number): NewWorkSource[] {
    return this.works.listSources(workId, 'image');
  }

  /**
   * 创建作品（单个短视频同时创建第 1 集）与素材文件。
   * @param creation 已校验的作品内容与素材。
   * @throws ConflictError 项目内名称重复。
   */
  createWork(projectId: number, creation: NormalizedWorkCreation): Work {
    if (!this.isWorkNameAvailable(projectId, creation.input.name)) {
      throw new ConflictError('workName', DUPLICATE_WORK_NAME_MESSAGE);
    }
    const work = this.works.insert(projectId, creation.input, creation.sources, this.now().toISOString());
    this.changeNotifier.notify(projectId);
    return work;
  }

  /**
   * 修改作品名称，在形态还能修改时一并修改形态；灵感图片作品还会整体替换图片。
   * @param id 作品标识。
   * @param rawInput 表单提交的原始内容。
   * @throws ValidationError 内容不合法。
   * @throws ConflictError 项目内名称重复。
   * @throws NotFoundError 作品不存在。
   */
  updateWork(id: number, rawInput: unknown): Work {
    const work = this.getWork(id);
    const update = normalizeWorkUpdate(rawInput, work.kind, this.canChangeKind(id), work.sourceType);
    if (!this.isWorkNameAvailable(work.projectId, update.name, id)) {
      throw new ConflictError('workName', DUPLICATE_WORK_NAME_MESSAGE);
    }
    const updated = this.works.update(id, update, this.now().toISOString());
    if (updated === undefined) {
      throw new NotFoundError(`作品 ${id} 不存在。`);
    }
    this.changeNotifier.notify(work.projectId);
    return updated;
  }

  /**
   * 删除作品及其下全部内容。
   * @throws NotFoundError 作品不存在。
   */
  deleteWork(id: number): void {
    const work = this.getWork(id);
    this.works.remove(id);
    this.changeNotifier.notify(work.projectId);
  }

  /** 作品转列表行：附带创意与剧本阶段的状态摘要。 */
  private toListItem(work: Work): WorkListItem {
    return {
      id: work.id,
      projectId: work.projectId,
      name: work.name,
      kind: work.kind,
      sourceType: work.sourceType,
      createdAt: work.createdAt,
      creative: this.describeStage(work.id, 'creative'),
      screenplay: this.describeStage(work.id, 'screenplay'),
      canStartScreenplay: this.runs.findCurrent({ workId: work.id, stage: 'creative', episodeId: null }) !== undefined
    };
  }

  /** 阶段的状态摘要：取最新版本的状态。 */
  private describeStage(workId: number, stage: StageKind): StageStatusSummary {
    const [latest] = this.runs.listVersions({ workId, stage, episodeId: null });
    if (latest === undefined) {
      return { display: 'none', runId: null, version: null, progressText: null, stale: false };
    }
    const source = latest.sourceRunId === null ? undefined : this.runs.findById(latest.sourceRunId);
    return {
      display: toDisplayStatus(latest),
      runId: latest.id,
      version: latest.version,
      progressText: formatProgress(latest),
      stale: latest.status === 'succeeded' && isStale(latest, source)
    };
  }
}

/** 运行中的记录显示“已完成 / 总数”。 */
function formatProgress(run: StageRun): string | null {
  if (run.status !== 'running' || run.progress === null || run.progress.total <= 0) {
    return null;
  }
  return `${run.progress.done} / ${run.progress.total}`;
}
