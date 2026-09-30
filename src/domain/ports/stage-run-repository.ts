// ------------------------------------------------------------------------
// 名称：stage-run-repository.ts
// 说明：阶段生成记录数据访问的端口接口，阶段执行器与确认服务依赖它，不依赖具体存储。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：同步调用；确认采用与创建记录需要原子性，由实现在事务内完成。
// ------------------------------------------------------------------------

import { NewStageRun, ReviewPatch, StageProgress, StageRun, StageTarget } from '../models/stage-run';

/** 阶段生成记录的数据访问接口。 */
export interface StageRunRepository {
  /** 按标识查找记录；不存在返回 undefined。 */
  findById(id: number): StageRun | undefined;
  /** 查找目标当前采用（已确认）的版本；没有返回 undefined。 */
  findCurrent(target: StageTarget): StageRun | undefined;
  /** 查找目标正在运行的记录；没有返回 undefined。 */
  findRunning(target: StageTarget): StageRun | undefined;
  /** 列出目标的全部版本，版本号从大到小。 */
  listVersions(target: StageTarget): StageRun[];

  /** 创建一条“运行中”的记录，版本号为目标现有最大版本加 1。 */
  create(input: NewStageRun, timestamp: string): StageRun;
  /** 更新进度；记录不存在时返回 undefined。 */
  updateProgress(id: number, progress: StageProgress): StageRun | undefined;
  /** 标记生成成功，状态为待确认。 */
  markSucceeded(id: number, timestamp: string): StageRun | undefined;
  /** 标记生成失败，保留原始输出便于排查。 */
  markFailed(id: number, errorMessage: string, rawOutput: string | null, timestamp: string): StageRun | undefined;
  /** 标记已取消。 */
  markCanceled(id: number, timestamp: string): StageRun | undefined;

  /**
   * 确认采用：在同一事务内把同一目标原来的当前版本置为历史，再写入确认状态。
   * @param patch 由确认规则计算出的状态。
   */
  approve(id: number, patch: ReviewPatch, timestamp: string): StageRun | undefined;
  /** 写入编辑后的确认状态（回到待确认、修订号加 1）。 */
  applyEdit(id: number, patch: ReviewPatch): StageRun | undefined;

  /** 扩展启动时把遗留的运行中记录置为失败；返回处理的数量。 */
  failInterrupted(errorMessage: string, timestamp: string): number;
}
