// ------------------------------------------------------------------------
// 名称：envelope.ts
// 说明：Webview 与扩展宿主之间的消息信封：请求、响应、事件及错误载荷。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：界面只发送“意图”请求，宿主返回响应；宿主主动推送用事件。
// ------------------------------------------------------------------------

/** 错误类别，界面据此决定展示方式。 */
export type ErrorKind = 'validation' | 'conflict' | 'not-found' | 'unsupported' | 'unavailable' | 'unexpected';

/** 响应中的错误载荷。 */
export interface ErrorPayload {
  readonly kind: ErrorKind;
  readonly message: string;
  /** 字段级错误，键为字段键；空串键表示表单级错误。 */
  readonly fieldErrors?: Readonly<Record<string, string>>;
}

/** 界面发给宿主的请求。 */
export interface RequestEnvelope {
  readonly type: 'request';
  /** 由界面生成，用于匹配响应。 */
  readonly requestId: number;
  /** 请求名称，如 `form.submit`。 */
  readonly name: string;
  readonly payload?: unknown;
}

/** 宿主对请求的响应。 */
export type ResponseEnvelope =
  | { readonly type: 'response'; readonly requestId: number; readonly ok: true; readonly data: unknown }
  | { readonly type: 'response'; readonly requestId: number; readonly ok: false; readonly error: ErrorPayload };

/** 宿主主动推送给界面的事件。 */
export interface EventEnvelope {
  readonly type: 'event';
  readonly name: string;
  readonly payload?: unknown;
}

/** 判断收到的消息是否为合法的请求信封。 */
export function isRequestEnvelope(value: unknown): value is RequestEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'request' && typeof candidate.requestId === 'number' && typeof candidate.name === 'string'
  );
}
