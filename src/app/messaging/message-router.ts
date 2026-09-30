// ------------------------------------------------------------------------
// 名称：message-router.ts
// 说明：请求路由：按请求名称把界面请求分发给已注册的处理函数，并统一包装响应与错误。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code，便于测试；每个面板持有一个路由器实例。
// ------------------------------------------------------------------------

import { ResponseEnvelope, isRequestEnvelope } from './envelope';
import { toErrorPayload } from './error-mapping';

/** 请求处理函数：接收请求载荷，返回响应数据；失败时抛出异常。 */
export type RequestHandler = (payload: unknown) => unknown | Promise<unknown>;

/** 请求路由器。 */
export class MessageRouter {
  private readonly handlers = new Map<string, RequestHandler>();

  /**
   * 注册请求处理函数；同名请求只能注册一次。
   * @param name 请求名称。
   * @param handler 处理函数。
   */
  register(name: string, handler: RequestHandler): this {
    if (this.handlers.has(name)) {
      throw new Error(`请求 ${name} 已注册处理函数。`);
    }
    this.handlers.set(name, handler);
    return this;
  }

  /**
   * 处理界面发来的消息。
   * @param message 收到的原始消息。
   * @returns 响应信封；消息不是合法请求时返回 undefined，不做响应。
   */
  async handle(message: unknown): Promise<ResponseEnvelope | undefined> {
    if (!isRequestEnvelope(message)) {
      return undefined;
    }

    const handler = this.handlers.get(message.name);
    if (handler === undefined) {
      return {
        type: 'response',
        requestId: message.requestId,
        ok: false,
        error: { kind: 'unsupported', message: `不支持的请求：${message.name}。` }
      };
    }

    try {
      const data = await handler(message.payload);
      return { type: 'response', requestId: message.requestId, ok: true, data };
    } catch (error) {
      return { type: 'response', requestId: message.requestId, ok: false, error: toErrorPayload(error) };
    }
  }
}
