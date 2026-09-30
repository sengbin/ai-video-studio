// ------------------------------------------------------------------------
// 名称：stage-run.ts
// 说明：阶段生成记录的领域模型：阶段、生成状态、确认状态、进度和提交输入。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：对应 stage_runs 表；确认机制见 docs/ARCHITECTURE.md 6.3。
// ------------------------------------------------------------------------

/** 由 Copilot 生成、需要人工确认的阶段。 */
export type StageKind = 'creative' | 'screenplay' | 'storyboard_script';

/** 生成状态：运行中、成功、失败、已取消。 */
export type StageRunStatus = 'running' | 'succeeded' | 'failed' | 'canceled';

/** 确认状态：待确认、已确认。 */
export type ReviewStatus = 'pending' | 'approved';

/** 界面展示用的合并状态；history 指已确认但不再是当前版本。 */
export type StageDisplayStatus = 'running' | 'pending' | 'approved' | 'history' | 'failed' | 'canceled';

/** 生成进度，供界面显示与中断后继续。 */
export interface StageProgress {
  /** 当前步骤名称，如“规划大纲”“生成第 3 章”。 */
  readonly step: string;
  readonly total: number;
  readonly done: number;
  /** 阶段自己的进度数据，如创意大纲。 */
  readonly detail?: unknown;
}

/** 一个阶段生成的目标：作品、阶段；分镜脚本阶段还要指定集。 */
export interface StageTarget {
  readonly workId: number;
  readonly stage: StageKind;
  readonly episodeId: number | null;
}

/** 创建阶段记录时的内容；版本号由存储层按目标递增分配。 */
export interface NewStageRun extends StageTarget {
  /** 表单输入快照。 */
  readonly input: Readonly<Record<string, unknown>>;
  /** 依赖的上游阶段记录；创意阶段为 null。 */
  readonly sourceRunId: number | null;
  /** 生成时上游记录的修订号。 */
  readonly sourceRevision: number | null;
  /** 使用的 Copilot 模型标识。 */
  readonly modelInfo: string | null;
}

/** 阶段生成记录。 */
export interface StageRun extends NewStageRun {
  readonly id: number;
  readonly version: number;
  readonly status: StageRunStatus;
  readonly reviewStatus: ReviewStatus;
  /** 是否为当前采用的版本；为 true 时必须已确认。 */
  readonly isCurrent: boolean;
  /** 产出内容每被编辑保存一次加 1，用于判断下游是否过期。 */
  readonly revision: number;
  readonly progress: StageProgress | null;
  /** 最近一次模型原始输出，仅失败时保留。 */
  readonly rawOutput: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly approvedAt: string | null;
  /** 仅剧本阶段：结构已合并到集和实体的时间。 */
  readonly appliedAt: string | null;
}

/** 确认状态的变更内容，由确认规则计算，存储层原子写入。 */
export interface ReviewPatch {
  readonly reviewStatus: ReviewStatus;
  readonly isCurrent: boolean;
  readonly revision: number;
  readonly approvedAt: string | null;
}
