// ------------------------------------------------------------------------
// 名称：webview-messaging.ts
// 说明：Webview 与请求路由器的消息连接：接收界面请求交给路由器并回复，向界面推送事件，并在 Webview 销毁时释放订阅、停止发送。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code 模块，只依赖结构化接口，便于测试；编辑器面板与侧栏视图共用。
// ------------------------------------------------------------------------

import { EventEnvelope } from '../messaging/envelope';
import { MessageRouter } from '../messaging/message-router';

/** 可释放的订阅，与 vscode.Disposable 结构兼容。 */
export interface Subscription {
  dispose(): unknown;
}

/** 连接所需的 Webview 能力，与 vscode.Webview 结构兼容。 */
export interface MessageWebview {
  /** 订阅界面发来的消息。 */
  onDidReceiveMessage(listener: (message: unknown) => unknown): Subscription;
  /** 向界面发送消息。 */
  postMessage(message: unknown): PromiseLike<boolean>;
}

/** Webview 所属的面板或视图，销毁时通知。 */
export interface WebviewOwner {
  /** 订阅销毁事件，与 vscode.WebviewPanel、vscode.WebviewView 的 onDidDispose 兼容。 */
  onDidDispose(listener: () => unknown): Subscription;
}

/** 已建立的消息连接。 */
export interface WebviewMessaging {
  /** 向界面推送事件；Webview 已销毁时忽略。 */
  postEvent(name: string, payload?: unknown): void;
}

/**
 * 把 Webview 的消息交给路由器处理并回复，同时提供向界面推送事件的能力。
 * 销毁后：释放消息订阅，不再回复请求，也不再推送事件。
 * @param webview 要连接的 Webview。
 * @param owner Webview 所属的面板或视图，用于感知销毁。
 * @param router 处理界面请求的路由器。
 */
export function connectWebviewMessaging(webview: MessageWebview, owner: WebviewOwner, router: MessageRouter): WebviewMessaging {
  let disposed = false;

  /**
   * 发送一条消息。Webview 销毁后停止发送；发送过程中恰好销毁导致的失败属于预期情况，直接忽略，
   * 因为面板已不存在，无人接收；销毁之前发生的失败（如消息无法序列化）则记录到控制台，避免被悄悄吞掉。
   */
  const send = async (message: unknown): Promise<void> => {
    if (disposed) {
      return;
    }
    try {
      await webview.postMessage(message);
    } catch (error) {
      if (disposed) {
        return;
      }
      console.error('向界面发送消息失败：', error);
    }
  };

  const receiveSubscription = webview.onDidReceiveMessage(async (message: unknown) => {
    const response = await router.handle(message);
    if (response === undefined) {
      return;
    }
    await send(response);
  });
  owner.onDidDispose(() => {
    disposed = true;
    receiveSubscription.dispose();
  });

  return {
    postEvent: (name, payload) => {
      const event: EventEnvelope = { type: 'event', name, payload };
      void send(event);
    }
  };
}
