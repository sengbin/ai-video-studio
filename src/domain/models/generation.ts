// ------------------------------------------------------------------------
// 名称：generation.ts
// 说明：视频生成的领域模型：生成任务及其状态、请求快照、失败原因、结果视频，以及提交时的生成参数。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 video_jobs、video_results 表；一个镜头组一次提交产生一条任务、一个多镜头视频，重新生成不覆盖历史；快照只保存素材引用，不含素材内容和密钥。
// ------------------------------------------------------------------------

import { ProviderFailure } from '../errors';
import { VideoAudioElement, VideoAudioMode } from './model-capability';

/** 任务状态：等待前序、排队、生成中、成功、失败、已取消。 */
export type JobStatus = 'waiting' | 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** 仍在进行的任务状态：这些状态下同一镜头组不能再次提交。 */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ['waiting', 'queued', 'running'];

/** 任务状态的界面名称。 */
export const JOB_STATUS_LABELS: Readonly<Record<JobStatus, string>> = {
  waiting: '等待前序',
  queued: '排队中',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消'
};

/** 提交时的生成参数；null 表示不指定，由模型使用默认值。 */
export interface GenerationParams {
  readonly modelId: number;
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly audioMode: VideoAudioMode | null;
  /** 声音模式为原生生成时选用的声音内容；null 表示模型支持的全部。 */
  readonly audioElements: readonly VideoAudioElement[] | null;
  /** 随机种子；null 表示不传（随机）。 */
  readonly seed: number | null;
  /** 本组指定的生成时长（秒）；null 表示按组内镜头总时长向上对齐到模型支持的取值。只来自镜头组覆盖，提交请求本身不携带。 */
  readonly durationSeconds: number | null;
  /** 负向清单：null 表示沿用默认清单，空串表示不要负向清单。提交请求携带的是已合并的值；镜头组的覆盖在合并参数时补上。 */
  readonly negativeList: string | null;
  /** 是否让平台改写提示词；null 表示不传，由平台用默认值（开启）。 */
  readonly promptExtend: boolean | null;
}

/** 任务请求快照中实际使用的参数（组时长已按模型能力调整）。 */
export interface SnapshotParams {
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly durationSeconds: number | null;
  readonly audioMode: VideoAudioMode | null;
  /** 实际传给模型的声音内容（已去掉模型不支持的项）；声音模式不是原生生成时为 null。早期版本提交的快照没有这个键。 */
  readonly audioElements?: readonly VideoAudioElement[] | null;
  readonly seed: number | null;
  /** 实际写在提示词末尾的负向清单原文（已去掉与正向重复的项）；没有时为 null。早期版本提交的快照没有这个键。 */
  readonly negativeList?: string | null;
  readonly extraParams: Readonly<Record<string, unknown>>;
}

/** 任务请求快照：提交时用到的全部内容，用于重试、排查和对比；素材只保存文件标识。 */
export interface JobSnapshot {
  readonly storyboardRunId: number;
  /** 本次生成包含的镜头，按序号排列。 */
  readonly shotIds: readonly number[];
  /** 提示词格式版本：用于区分不同写法编译出的提示词；早期版本提交的快照没有这个键，视为 1。 */
  readonly promptFormat?: number;
  readonly providerCode: string;
  readonly modelCode: string;
  /** 实际使用的提示词，已包含声音与参考素材的说明。 */
  readonly prompt: string;
  readonly params: SnapshotParams;
  readonly referenceImageFileIds: readonly number[];
  readonly referenceAudioFileIds: readonly number[];
  /** 指定图片作首帧时使用的资产图片文件；没有指定、或早期版本提交的快照没有这个键。 */
  readonly firstFrameFileId?: number | null;
  /** 提交时给出的提醒（如参考图被截断），不阻断提交。 */
  readonly warnings: readonly string[];
}

/** 任务失败的原因：分类、平台错误码和平台返回的原文。 */
export interface JobFailure {
  readonly category: ProviderFailure;
  readonly code: string | null;
  readonly message: string;
}

/** 一条生成任务。 */
export interface VideoJobRecord {
  readonly id: number;
  readonly groupId: number;
  readonly modelId: number;
  readonly status: JobStatus;
  readonly snapshot: JobSnapshot;
  readonly remoteJobId: string | null;
  /** 仅失败的任务有。 */
  readonly failure: JobFailure | null;
  /** 同一镜头组的第几次提交，从 1 开始。 */
  readonly attempt: number;
  readonly prevJobId: number | null;
  readonly firstFrameId: number | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly finishedAt: string | null;
}

/** 新建任务的内容。 */
export interface NewVideoJob {
  readonly groupId: number;
  readonly modelId: number;
  readonly status: 'queued' | 'waiting';
  readonly snapshot: JobSnapshot;
  /** 首帧依赖的前序任务（取它结果视频的尾帧）；不依赖为 null。 */
  readonly prevJobId: number | null;
  /** 已就绪的首帧（尾帧图片）；等待前序时为 null。 */
  readonly firstFrameId: number | null;
}

/** 要写入的尾帧图片。 */
export interface NewResultFrame {
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** 要写入的结果视频。 */
export interface NewVideoResult {
  /** 相对存储根目录的文件路径。 */
  readonly filePath: string;
  readonly remoteUrl: string | null;
  readonly durationSeconds: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly sizeBytes: number;
  readonly hasAudio: boolean;
}

/** 已保存的结果视频。 */
export interface VideoResultRecord extends NewVideoResult {
  readonly id: number;
  readonly jobId: number;
  readonly groupId: number;
  readonly isSelected: boolean;
  readonly createdAt: string;
}

/** 镜头组所在的项目、作品和集，用于确定结果文件的存放位置。 */
export interface GroupLocation {
  readonly projectId: number;
  readonly workId: number;
  readonly episodeId: number;
}
