// ------------------------------------------------------------------------
// 名称：fake-fetch.ts
// 说明：测试用的假 fetch：按顺序返回预设响应并记录每次请求，供千问AI平台各类型适配器的测试共用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除。
// ------------------------------------------------------------------------

/** 一次记录下来的网络请求。 */
export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

/** 预设响应：正常响应，或要抛出的网络错误。 */
export type FakeResponse = { status?: number; body: unknown } | Error;

/**
 * 创建按顺序返回预设响应的假 fetch。
 * @param responses 预设响应，每次请求取出第一项；耗尽后抛出错误。
 * @returns 假 fetch 与调用记录。
 */
export function createFakeFetch(responses: FakeResponse[]): { fetchFunction: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFunction = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('没有预设的响应');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { fetchFunction, calls };
}
