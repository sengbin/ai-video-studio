// ------------------------------------------------------------------------
// 名称：work-service.ts
// 说明：作品应用服务：列出项目下的作品及其创意阶段状态、检查名称唯一、创建与删除作品，变化后通知订阅者。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code 和具体存储；输入校验由领域规则完成，创建作品接收已规范化的内容，时钟可注入以便测试。
// ------------------------------------------------------------------------

import { ConflictError, NotFoundError } from '../../domain/errors';
import { StageDisplayStatus, StageRun } from '../../domain/models/stage-run';
import { Work, WorkKind, WorkSourceType } from '../../domain/models/work';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { WorkRepository } from '../../domain/ports/work-repository';
import { toDisplayStatus } from '../../domain/rules/stage-review-rules';
import { NormalizedWorkCreation } from '../../domain/rules/work-rules';
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
}

/** 作品列表中的一行：作品及其创意阶段状态。 */
export interface WorkListItem {
  readonly id: number;
  readonly projectId: number;
  readonly name: string;
  readonly kind: WorkKind;
  readonly sourceType: WorkSourceType;
  readonly createdAt: string;
  readonly creative: StageStatusSummary;
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
    return this.works.listByProject(projectId).map((work) => ({
      id: work.id,
      projectId: work.projectId,
      name: work.name,
      kind: work.kind,
      sourceType: work.sourceType,
      createdAt: work.createdAt,
      creative: this.describeCreative(work.id)
    }));
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

  /** 判断作品名称在项目内是否可用，用于表单在字段失去焦点时检查重名。 */
  isWorkNameAvailable(projectId: number, name: string): boolean {
    return this.works.findByName(projectId, name.trim()) === undefined;
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
   * 删除作品及其下全部内容。
   * @throws NotFoundError 作品不存在。
   */
  deleteWork(id: number): void {
    const work = this.getWork(id);
    this.works.remove(id);
    this.changeNotifier.notify(work.projectId);
  }

  /** 创意阶段的状态摘要：取最新版本的状态。 */
  private describeCreative(workId: number): StageStatusSummary {
    const [latest] = this.runs.listVersions({ workId, stage: 'creative', episodeId: null });
    if (latest === undefined) {
      return { display: 'none', runId: null, version: null, progressText: null };
    }
    return {
      display: toDisplayStatus(latest),
      runId: latest.id,
      version: latest.version,
      progressText: formatProgress(latest)
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
