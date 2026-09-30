// ------------------------------------------------------------------------
// 名称：change-notifier.ts
// 说明：轻量的数据变化通知器：服务在数据变化后通知订阅者刷新界面。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code，可在测试中直接使用。
// ------------------------------------------------------------------------

/** 数据变化的订阅者。 */
export type ChangeListener = () => void;

/** 数据变化通知器。 */
export class ChangeNotifier {
  private readonly listeners = new Set<ChangeListener>();

  /**
   * 订阅数据变化。
   * @param listener 变化发生时调用的函数。
   * @returns 取消订阅的函数。
   */
  subscribe(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 通知全部订阅者；某个订阅者抛出异常不影响其余订阅者。 */
  notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('数据变化订阅者执行失败：', error);
      }
    }
  }
}
