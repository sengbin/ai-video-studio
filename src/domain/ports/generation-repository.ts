// ------------------------------------------------------------------------
// 名称：generation-repository.ts
// 说明：生成任务与结果视频数据访问的端口接口，以及任务提交时读取素材内容、保存结果文件的端口。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：状态变更方法只在任务仍处于允许的状态时生效并返回 true，避免覆盖已取消或已结束的任务；同步调用。
// ------------------------------------------------------------------------

import { GroupLocation, JobFailure, JobStatus, NewResultFrame, NewVideoJob, NewVideoResult, VideoJobRecord, VideoResultRecord } from '../models/generation';
import { MediaInput } from './provider-adapters';

/** 生成任务与结果视频的数据访问接口。 */
export interface GenerationRepository {
  /** 新增任务，`attempt` 为该镜头组已有任务数加 1。 */
  insertJob(job: NewVideoJob, timestamp: string): VideoJobRecord;

  /** 按标识读取任务；不存在返回 undefined。 */
  findJob(id: number): VideoJobRecord | undefined;

  /** 列出若干镜头组的全部任务，按创建时间从新到旧。 */
  listJobsByGroups(groupIds: readonly number[]): VideoJobRecord[];

  /** 列出处于给定状态的全部任务，按标识升序（先提交先处理）。 */
  listJobsByStatus(statuses: readonly JobStatus[]): VideoJobRecord[];

  /** 镜头组是否有仍在进行（等待、排队、生成中）的任务。 */
  hasActiveJob(groupId: number): boolean;

  /** 排队中的任务已提交给服务商：记下远端标识，状态变为生成中。任务不是排队中返回 false。 */
  markSubmitted(id: number, remoteJobId: string, timestamp: string): boolean;

  /**
   * 生成成功：写入结果视频，任务状态变为成功；镜头组还没有采用的版本时自动采用本条。
   * @returns 写入的结果；任务不是进行中的状态时返回 undefined。
   */
  markSucceeded(id: number, result: NewVideoResult, timestamp: string): VideoResultRecord | undefined;

  /** 生成失败：记录失败原因。任务不是进行中的状态时返回 false。 */
  markFailed(id: number, failure: JobFailure, timestamp: string): boolean;

  /** 取消任务。任务不是进行中的状态时返回 false。 */
  markCanceled(id: number, timestamp: string): boolean;

  /** 等待前序的任务首帧已就绪：记下首帧，状态变为排队中。任务不是等待前序时返回 false。 */
  releaseWaitingJob(id: number, firstFrameId: number): boolean;

  /** 写入结果视频的尾帧（已有则替换）；结果不存在返回 undefined，否则返回尾帧标识。 */
  saveResultFrame(resultId: number, frame: NewResultFrame, timestamp: string): number | undefined;

  /** 结果视频的尾帧标识；还没有尾帧返回 undefined。 */
  findResultFrameId(resultId: number): number | undefined;

  /** 任务的结果视频；没有返回 undefined。 */
  findResultByJob(jobId: number): VideoResultRecord | undefined;

  /** 有等待前序的任务依赖、但还没有尾帧的结果视频。 */
  listResultsAwaitingFrame(): VideoResultRecord[];

  /** 列出若干镜头组的全部结果视频，按创建时间从新到旧。 */
  listResultsByGroups(groupIds: readonly number[]): VideoResultRecord[];

  /** 按标识读取结果视频；不存在返回 undefined。 */
  findResult(id: number): VideoResultRecord | undefined;

  /** 把结果视频设为所在镜头组采用的版本（原采用的取消）；结果不存在返回 false。 */
  selectResult(id: number): boolean;

  /** 读取镜头组所在的项目、作品和集；镜头组不存在返回 undefined。 */
  getGroupLocation(groupId: number): GroupLocation | undefined;
}

/** 读取任务提交所需的素材内容：资产文件与尾帧图片。 */
export interface JobMediaReader {
  /** 读取资产文件；不存在返回 undefined。 */
  readAssetFile(id: number): MediaInput | undefined;

  /** 读取结果视频的尾帧图片；不存在返回 undefined。 */
  readResultFrame(id: number): MediaInput | undefined;
}

/** 已保存的结果文件。 */
export interface SavedResultFile {
  /** 相对存储根目录的路径，使用 / 分隔。 */
  readonly filePath: string;
  readonly sizeBytes: number;
}

/** 保存生成结果文件：把服务商的临时地址下载到本地。 */
export interface ResultStore {
  /**
   * 下载结果视频并保存。
   * @param location 镜头组所在的项目、作品和集。
   * @param groupId 镜头组标识。
   * @param jobId 任务标识。
   * @param url 服务商返回的临时地址。
   * @param signal 取消信号。
   * @throws Error 下载失败、地址不合法或文件过大。
   */
  save(location: GroupLocation, groupId: number, jobId: number, url: string, signal?: AbortSignal): Promise<SavedResultFile>;

  /** 把相对路径转换为本机绝对路径。 */
  resolvePath(filePath: string): string;
}
