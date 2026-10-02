// ------------------------------------------------------------------------
// 名称：qianwen-api-client.ts
// 说明：千问AI平台（DashScope 原生接口）的 HTTP 客户端：带鉴权的 JSON 请求，并把网络错误、HTTP 状态和错误码统一转换为 ProviderError。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：fetch 可注入以便测试；错误信息只包含服务端返回的说明，不包含访问密钥。
// ------------------------------------------------------------------------

import { ProviderError, ProviderFailure } from '../../../domain/errors';
import { ProviderCallContext } from '../../../domain/ports/provider-adapters';
import { QIANWEN_ENDPOINT_MESSAGE, QIANWEN_ENDPOINT_PATTERN, QIANWEN_ENDPOINT_SETTING_KEY } from './qianwen-catalog';

/** 可注入的 fetch 函数类型。 */
export type FetchFunction = typeof fetch;

/** 平台错误响应的结构：错误码与说明。 */
interface ErrorBody {
  readonly code?: unknown;
  readonly message?: unknown;
}

/** 错误码前缀与失败分类的对应，按顺序匹配。 */
const ERROR_CODE_CATEGORIES: ReadonlyArray<readonly [prefix: string, category: ProviderFailure]> = [
  ['DataInspectionFailed', 'content_rejected'],
  ['IPInfringementSuspect', 'content_rejected'],
  ['Throttling', 'rate_limited'],
  ['InvalidApiKey', 'auth'],
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

  private async send(
    context: ProviderCallContext,
    path: string,
    request: { readonly method: string; readonly body?: string; readonly extraHeaders: Readonly<Record<string, string>> }
  ): Promise<Record<string, unknown>> {
    const endpoint = context.settings[QIANWEN_ENDPOINT_SETTING_KEY];
    if (endpoint === undefined || endpoint === '') {
      throw new ProviderError('invalid_request', '尚未配置千问AI平台的接口地址。');
    }
    // 设置页会校验，这里再检查一次，避免早先保存的错误地址让请求发往错误的路径。
    if (!new RegExp(QIANWEN_ENDPOINT_PATTERN).test(endpoint)) {
      throw new ProviderError('invalid_request', QIANWEN_ENDPOINT_MESSAGE);
    }

    let response: Response;
    try {
      response = await this.fetchFunction(`${endpoint}${path}`, {
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

    const payload = await readJsonObject(response);
    if (!response.ok) {
      const { code, message } = payload as ErrorBody;
      const errorCode = typeof code === 'string' ? code : null;
      const category = classifyErrorCode(errorCode) ?? classifyStatus(response.status);
      const detail = typeof message === 'string' && message !== '' ? message : `HTTP ${response.status}`;
      throw new ProviderError(category, `千问AI平台返回错误${errorCode === null ? '' : `（${errorCode}）`}：${detail}`, { code: errorCode });
    }
    return payload;
  }
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
