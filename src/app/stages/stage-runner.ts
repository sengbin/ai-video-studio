// ------------------------------------------------------------------------
// 名称：stage-runner.ts
// 说明：阶段执行器：启动、重试、取消阶段生成，记录状态与进度，并通知界面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：生成在后台异步执行，start 与 resume 在记录创建后立即返回；同一目标同时只有一个运行中的记录。
// ------------------------------------------------------------------------

import { NotFoundError, TextGenerationError, ValidationError, FORM_LEVEL_ERROR_KEY } from '../../domain/errors';
import { StageRun, StageTarget } from '../../domain/models/stage-run';
import { StageRunRepository } from '../../domain/ports/stage-run-repository';
import { TextGenerationPort, TextModelInfo } from '../../domain/ports/text-generation-port';
import { UPSTREAM_STAGE, assertCanStart, canRetry } from '../../domain/rules/stage-review-rules';
import { OutputRetryExhaustedError } from './structured-generation';
import { StageWorkflow } from './stage-workflow';

/** 扩展重启后遗留的运行中记录被置为失败时写入的原因。 */
export const INTERRUPTED_MESSAGE = '扩展重启，已中断。';

/** 启动阶段生成的请求。 */
export interface StartStageRequest {
  readonly target: StageTarget;
  /** 界面提交的原始输入，由对应阶段工作流校验。 */
  readonly input: unknown;
}

/** 阶段执行器的依赖。 */
export interface StageRunnerDependencies {
  readonly runs: StageRunRepository;
  readonly text: TextGenerationPort;
  readonly workflows: readonly StageWorkflow[];
  /** 时钟，测试时可替换。 */
  readonly now?: () => Date;
  /** 记录状态或进度变化时调用，用于向界面推送 stageRunUpdated。 */
  readonly notify?: (run: StageRun) => void;
}

/** 正在后台执行的生成。 */
interface ActiveRun {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/** 阶段执行器。 */
export class StageRunner {
  private readonly active = new Map<number, ActiveRun>();

  constructor(private readonly dependencies: StageRunnerDependencies) {}

  /**
   * 启动一次阶段生成：校验输入与前置条件，创建“运行中”的记录并在后台执行。
   * @returns 新创建的记录。
   * @throws ValidationError 输入不合法、上游未确认或同一目标正在生成。
   * @throws TextGenerationError 没有可用的文本模型。
   */
  async start(request: StartStageRequest): Promise<StageRun> {
    const { runs, text } = this.dependencies;
    const workflow = this.workflowFor(request.target.stage);
    const input = workflow.normalizeInput(request.input);
    const model = await text.resolveModel();

    // 模型解析是异步的，检查与创建放在其后同步完成，避免并发启动时重复创建。
    const upstreamStage = UPSTREAM_STAGE[request.target.stage];
    const upstream =
      upstreamStage === null ? undefined : runs.findCurrent({ workId: request.target.workId, stage: upstreamStage, episodeId: null });
    assertCanStart({ stage: request.target.stage, upstream, running: runs.findRunning(request.target) });

    const run = runs.create(
      {
        ...request.target,
        input,
        sourceRunId: upstream?.id ?? null,
        sourceRevision: upstream?.revision ?? null,
        modelInfo: model.id
      },
      this.timestamp()
    );
    this.launch(run, workflow, model);
    return run;
  }

  /**
   * 重试失败或已取消的记录：从已保存的进度与产出继续，不产生新版本。
   * @throws NotFoundError 记录不存在。
   * @throws ValidationError 记录不是失败或已取消，或同一目标正在生成。
   */
  async resume(runId: number): Promise<StageRun> {
    const { runs, text } = this.dependencies;
    const existing = runs.findById(runId);
    if (existing === undefined) {
      throw new NotFoundError('阶段记录不存在。');
    }
    if (!canRetry(existing)) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '只有失败或已取消的记录才能重试。' });
    }
    const workflow = this.workflowFor(existing.stage);
    const model = await text.resolveModel();

    if (runs.findRunning(existing) !== undefined) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '该阶段正在生成，请等待完成或先取消。' });
    }
    const resumed = runs.markRunning(runId);
    if (resumed === undefined) {
      throw new NotFoundError('阶段记录不存在。');
    }
    this.publish(resumed);
    this.launch(resumed, workflow, model);
    return resumed;
  }

  /**
   * 取消正在生成的记录。
   * @returns 是否找到了正在执行的生成。
   */
  cancel(runId: number): boolean {
    const active = this.active.get(runId);
    if (active === undefined) {
      return false;
    }
    active.controller.abort();
    return true;
  }

  /** 等待当前所有后台生成结束，主要用于测试与扩展关闭。 */
  async whenIdle(): Promise<void> {
    await Promise.all([...this.active.values()].map((active) => active.done));
  }

  /**
   * 把遗留的运行中记录置为失败；扩展启动时调用一次。
   * @returns 处理的记录数。
   */
  recoverInterrupted(): number {
    return this.dependencies.runs.failInterrupted(INTERRUPTED_MESSAGE, this.timestamp());
  }

  private workflowFor(stage: StageTarget['stage']): StageWorkflow {
    const workflow = this.dependencies.workflows.find((candidate) => candidate.stage === stage);
    if (workflow === undefined) {
      throw new Error(`没有注册阶段 ${stage} 的工作流。`);
    }
    return workflow;
  }

  private timestamp(): string {
    return (this.dependencies.now?.() ?? new Date()).toISOString();
  }

  private publish(run: StageRun | undefined): void {
    if (run !== undefined) {
      this.dependencies.notify?.(run);
    }
  }

  /** 在后台启动执行，登记到活动列表，结束后移除。 */
  private launch(run: StageRun, workflow: StageWorkflow, model: TextModelInfo): void {
    const controller = new AbortController();
    const done = this.execute(run, workflow, model, controller.signal).finally(() => {
      this.active.delete(run.id);
    });
    this.active.set(run.id, { controller, done });
  }

  /** 执行工作流，并把结果记录为成功、失败或已取消；不向外抛出异常。 */
  private async execute(run: StageRun, workflow: StageWorkflow, model: TextModelInfo, signal: AbortSignal): Promise<void> {
    const { runs, text } = this.dependencies;
    try {
      await workflow.execute({
        run,
        model,
        text,
        signal,
        reportProgress: (progress) => this.publish(runs.updateProgress(run.id, progress))
      });
      if (signal.aborted) {
        throw new TextGenerationError('canceled', '已取消。');
      }
      this.publish(runs.markSucceeded(run.id, this.timestamp()));
    } catch (error) {
      const canceled = signal.aborted || (error instanceof TextGenerationError && error.category === 'canceled');
      if (canceled) {
        this.publish(runs.markCanceled(run.id, this.timestamp()));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const rawOutput = error instanceof OutputRetryExhaustedError ? error.rawOutput : null;
      this.publish(runs.markFailed(run.id, message, rawOutput, this.timestamp()));
    }
  }
}
