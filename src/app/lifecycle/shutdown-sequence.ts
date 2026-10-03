// ------------------------------------------------------------------------
// 名称：shutdown-sequence.ts
// 说明：扩展停用时的收尾序列：按登记顺序依次等待各收尾步骤完成，最后统一执行必须殿后的步骤（如关闭数据库），整体只执行一次。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code。VS Code 只等待 deactivate 返回的 Promise，不等待 subscriptions 里 dispose 返回的 Promise，因此收尾必须经 deactivate 返回；单个步骤失败只记录日志，不阻止后续步骤（尤其是关闭数据库）。
// ------------------------------------------------------------------------

/** 一个收尾步骤，可以是同步或异步的。 */
export type ShutdownStep = () => void | Promise<void>;

/** 停用时的收尾序列。 */
export class ShutdownSequence {
  private readonly steps: ShutdownStep[] = [];
  private readonly finalSteps: ShutdownStep[] = [];
  private running: Promise<void> | undefined;

  /**
   * 登记普通收尾步骤，按登记顺序依次执行，上一个步骤结束（含异步）后才开始下一个。
   * @param step 收尾步骤。
   */
  add(step: ShutdownStep): void {
    this.steps.push(step);
  }

  /**
   * 登记殿后步骤：无论登记先后，都在全部普通步骤结束之后才执行，如关闭数据库。
   * @param step 收尾步骤。
   */
  addFinal(step: ShutdownStep): void {
    this.finalSteps.push(step);
  }

  /**
   * 执行收尾序列；重复调用返回同一次执行的结果，不会重复执行步骤。
   * @returns 全部步骤结束后完成；单个步骤失败只记录日志，不会拒绝。
   */
  run(): Promise<void> {
    if (this.running === undefined) {
      this.running = this.runAll();
    }
    return this.running;
  }

  private async runAll(): Promise<void> {
    for (const step of [...this.steps, ...this.finalSteps]) {
      try {
        await step();
      } catch (error) {
        console.error('停用扩展时的收尾步骤失败：', error);
      }
    }
  }
}