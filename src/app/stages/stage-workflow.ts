// ------------------------------------------------------------------------
// 名称：stage-workflow.ts
// 说明：阶段工作流的接口：每个阶段（创意、剧本、分镜脚本）实现它，由阶段执行器统一驱动。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：工作流只负责“如何生成并保存产出”；状态流转、取消、失败记录由执行器负责。
// ------------------------------------------------------------------------

import { StageKind, StageProgress, StageRun } from '../../domain/models/stage-run';
import { TextGenerationPort, TextModelInfo } from '../../domain/ports/text-generation-port';

/** 工作流执行时可用的上下文。 */
export interface StageContext {
  /** 本次执行的阶段记录；重试时带有上次保存的进度，用于从中断处继续。 */
  readonly run: StageRun;
  readonly model: TextModelInfo;
  readonly text: TextGenerationPort;
  /** 取消信号；工作流应把它传给文本生成端口，并在步骤之间检查。 */
  readonly signal: AbortSignal;
  /** 保存进度并通知界面。 */
  reportProgress(progress: StageProgress): void;
}

/** 一个阶段的生成流程。 */
export interface StageWorkflow {
  readonly stage: StageKind;
  /**
   * 校验并规范化界面提交的输入，结果保存为阶段记录的输入快照。
   * @throws ValidationError 输入不合法。
   */
  normalizeInput(rawInput: unknown): Readonly<Record<string, unknown>>;
  /**
   * 执行生成并逐步保存产出；失败时抛出异常，已保存的部分保留。
   * 需要幂等：重试时根据已保存的产出与进度跳过已完成的步骤。
   */
  execute(context: StageContext): Promise<void>;
}
