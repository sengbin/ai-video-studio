// ------------------------------------------------------------------------
// 名称：qianwen-api-client.ts
// 说明：千问AI平台（DashScope 原生接口）的 HTTP 客户端：带鉴权的 JSON 请求与 OpenAI 兼容接口的流式请求，并把网络错误、HTTP 状态和错误码统一转换为 ProviderError；提供测试连接。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：fetch 可注入以便测试；错误信息只包含服务端返回的说明，不包含访问密钥；兼容接口的地址由原生接口地址推导，用户只需配置一个接口地址。
// ------------------------------------------------------------------------

import { ProviderError, ProviderFailure } from '../../../domain/errors';
import { ProviderCallContext } from '../../../domain/ports/provider-adapters';
import { QIANWEN_ENDPOINT_MESSAGE, QIANWEN_ENDPOINT_PATTERN, QIANWEN_ENDPOINT_SETTING_KEY } from './qianwen-catalog';

/** 可注入的 fetch 函数类型。 */
export type FetchFunction = typeof fetch;

/** 平台错误响应的结构：错误码与说明；原生接口直接在顶层，OpenAI 兼容接口放在 error 对象里。 */
interface ErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly error?: unknown;
}

/** OpenAI 兼容接口的路径前缀，由原生接口地址末尾的 /api/v1 替换而来。 */
const COMPATIBLE_MODE_PATH = '/compatible-mode/v1';

/** 错误码前缀与失败分类的对应，按顺序匹配。 */
const ERROR_CODE_CATEGORIES: ReadonlyArray<readonly [prefix: string, category: ProviderFailure]> = [
  ['DataInspectionFailed', 'content_rejected'],
  ['data_inspection_failed', 'content_rejected'],
  ['IPInfringementSuspect', 'content_rejected'],
  ['Throttling', 'rate_limited'],
  ['InvalidApiKey', 'auth'],
  ['invalid_api_key', 'auth'],
  ['InvalidParameter', 'invalid_request']
];

/**
 * 按错误码判断失败分类。
 * @param code 平台返回的错误码。
 * @returns 分类；不认识的错误码返回 null，由调用方决定如何回退。
 */
export function classifyErrorCode(code: string | null): ProviderFailure | null {
  const match = ERROR_CODE_CATEGORIES.find(([prefix]) => code !== null && code.startsWith(prefix));
  return match === undefined ? null : match[1];
}

/** 按 HTTP 状态判断失败分类。 */
function classifyStatus(status: number): ProviderFailure {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'server';
}

/** 千问AI平台 HTTP 客户端。 */
export class QianwenApiClient {
  constructor(private readonly fetchFunction: FetchFunction = fetch) {}

  /**
   * 以 JSON 提交请求体。
   * @param context 调用凭据与设置。
   * @param path 相对接口地址的路径，以 / 开头。
   * @param body 请求体对象。
   * @param extraHeaders 附加请求头。
   * @returns 响应的 JSON 对象。
   * @throws ProviderError 网络失败、非 2xx 响应，或响应不是 JSON 对象。
   */
  postJson(context: ProviderCallContext, path: string, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): Promise<Record<string, unknown>> {
    return this.send(context, path, { method: 'POST', body: JSON.stringify(body), extraHeaders: { 'Content-Type': 'application/json', ...extraHeaders } });
  }

  /**
   * 发起 GET 请求。
   * @param context 调用凭据与设置。
   * @param path 相对接口地址的路径，以 / 开头。
   * @returns 响应的 JSON 对象。
   * @throws ProviderError 网络失败、非 2xx 响应，或响应不是 JSON 对象。
   */
  getJson(context: ProviderCallContext, path: string): Promise<Record<string, unknown>> {
    return this.send(context, path, { method: 'GET', extraHeaders: {} });
  }

  /**
   * 确认接口地址与访问密钥可用：查询一个不存在的任务。平台返回带错误码的业务错误（如任务不存在）说明请求已通过鉴权。
   * @param context 调用凭据与设置。
   * @param probePath 查询不存在任务的接口路径，以 / 开头。
   * @throws ProviderError 鉴权失败、网络故障、服务端错误，或响应不像平台的业务错误（接口地址可能不正确）。
   */
  async checkConnection(context: ProviderCallContext, probePath: string): Promise<void> {
    try {
      await this.getJson(context, probePath);
    } catch (error) {
      if (error instanceof ProviderError && error.category === 'invalid_request') {
        if (error.code !== null) {
          return;
        }
        throw new ProviderError('invalid_request', `${error.message}。请检查接口地址是否正确。`, { cause: error });
      }
      throw error;
    }
  }

  /**
   * 向 OpenAI 兼容接口提交流式请求，逐条产出事件的 data 内容（不含 `[DONE]` 结束标记）。
   * @param context 调用凭据与设置；兼容接口的地址由原生接口地址末尾的 /api/v1 替换为 /compatible-mode/v1 得到。
   * @param path 相对兼容接口地址的路径，以 / 开头。
   * @param body 请求体对象，由调用方设置 stream 为 true。
   * @throws ProviderError 网络失败、非 2xx 响应，或读取流时中断。
   */
  async *postEventStream(context: ProviderCallContext, path: string, body: unknown): AsyncGenerator<string> {
    const base = readEndpoint(context).replace(new RegExp(QIANWEN_ENDPOINT_PATTERN), COMPATIBLE_MODE_PATH);
    const response = await this.fetchOrThrow(`${base}${path}`, context, {
      method: 'POST',
      body: JSON.stringify(body),
      extraHeaders: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
    });
    if (!response.ok) {
      throw buildHttpError(response.status, await readJsonObject(response));
    }
    if (response.body === null) {
      throw new ProviderError('server', '千问AI平台没有返回内容。');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        // 事件以换行分隔，只取 data 行；最后一段没有换行结尾时在流结束后一并处理。
        const lines = buffer.split('\n');
        buffer = done ? '' : (lines.pop() ?? '');
        for (const line of lines) {
          const data = readDataLine(line);
          if (data === '[DONE]') {
            return;
          }
          if (data !== null) {
            yield data;
          }
        }
        if (done) {
          return;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      throw new ProviderError('network', `读取千问AI平台的响应时中断：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async send(
    context: ProviderCallContext,
    path: string,
    request: { readonly method: string; readonly body?: string; readonly extraHeaders: Readonly<Record<string, string>> }
  ): Promise<Record<string, unknown>> {
    const endpoint = readEndpoint(context);
    const response = await this.fetchOrThrow(`${endpoint}${path}`, context, {
      method: request.method,
      body: request.body,
      extraHeaders: request.extraHeaders
    });
    const payload = await readJsonObject(response);
    if (!response.ok) {
      throw buildHttpError(response.status, payload);
    }
    return payload;
  }

  /** 发起请求；网络失败转换为 ProviderError，主动取消原样抛出。 */
  private async fetchOrThrow(
    url: string,
    context: ProviderCallContext,
    request: { readonly method: string; readonly body?: string; readonly extraHeaders: Readonly<Record<string, string>> }
  ): Promise<Response> {
    try {
      return await this.fetchFunction(url, {
        method: request.method,
        headers: { Authorization: `Bearer ${context.apiKey}`, ...request.extraHeaders },
        body: request.body,
        signal: context.signal
      });
    } catch (error) {
      // 主动取消不属于服务商故障，原样抛出交给调用方识别。
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw new ProviderError('network', `无法连接千问AI平台：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

/** 读取 SSE 的一行；不是非空的 data 行时返回 null。 */
function readDataLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const data = trimmed.slice('data:'.length).trim();
  return data === '' ? null : data;
}

/** 取并校验接口地址；设置页会校验，这里再检查一次，避免早先保存的错误地址让请求发往错误的路径。 */
function readEndpoint(context: ProviderCallContext): string {
  const endpoint = context.settings[QIANWEN_ENDPOINT_SETTING_KEY];
  if (endpoint === undefined || endpoint === '') {
    throw new ProviderError('invalid_request', '尚未配置千问AI平台的接口地址。');
  }
  if (!new RegExp(QIANWEN_ENDPOINT_PATTERN).test(endpoint)) {
    throw new ProviderError('invalid_request', QIANWEN_ENDPOINT_MESSAGE);
  }
  return endpoint;
}

/** 从错误响应中取出错误码与说明，兼容原生与 OpenAI 兼容两种结构。 */
function readErrorFields(payload: Record<string, unknown>): { readonly code: string | null; readonly message: string | null } {
  const body = payload as ErrorBody;
  const source = typeof body.error === 'object' && body.error !== null ? (body.error as ErrorBody) : body;
  return {
    code: typeof source.code === 'string' ? source.code : null,
    message: typeof source.message === 'string' && source.message !== '' ? source.message : null
  };
}

/** 把非 2xx 响应转换为带分类的错误。 */
function buildHttpError(status: number, payload: Record<string, unknown>): ProviderError {
  const { code, message } = readErrorFields(payload);
  const category = classifyErrorCode(code) ?? classifyStatus(status);
  return new ProviderError(category, `千问AI平台返回错误${code === null ? '' : `（${code}）`}：${message ?? `HTTP ${status}`}`, { code });
}

/** 读取响应体并解析为 JSON 对象；响应体为空或不是对象时返回空对象。 */
async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
