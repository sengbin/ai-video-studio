// ------------------------------------------------------------------------
// 名称：qianwen-api-client.ts
// 说明：千问AI平台（DashScope 原生接口）的 HTTP 客户端：带鉴权的 JSON 请求与 OpenAI 兼容接口的流式请求，并把网络错误、超时、HTTP 状态和错误码统一转换为 ProviderError；提供测试连接。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：fetch 与超时可注入以便测试；所有请求都有超时（普通请求总超时，流式生成空闲超时），并与调用方的取消信号合并；网络错误消息只含固定说明与脱敏摘要，不含地址与访问密钥，也不携带原始异常；兼容接口的地址由原生接口地址推导，用户只需配置一个接口地址。
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

/** 每秒的毫秒数，用于把超时毫秒数换算为说明文字里的秒数。 */
const MS_PER_SECOND = 1000;

/** 调用方自带的超时信号触发时的说明（不知道具体时长）。 */
const CALLER_TIMEOUT_MESSAGE = '请求超时：千问AI平台没有在限定时间内响应。';

/** 网络错误摘要的最大长度（字符数）。 */
const NETWORK_SUMMARY_MAX_LENGTH = 120;

/** 底层系统错误码的格式，如 ECONNREFUSED、ENOTFOUND。 */
const SYSTEM_ERROR_CODE_PATTERN = /^E[A-Z0-9_]{2,}$/;

/** 脱敏后替换密钥类内容、地址类内容的占位文字。 */
const REDACTED_SECRET = '[已隐藏]';
const REDACTED_ADDRESS = '[地址]';

/** 摘要为空时的说明。 */
const UNKNOWN_ERROR_TEXT = '未知错误';

/** 网络失败说明的固定前缀：普通请求、流式读取中断。 */
const CONNECT_FAILED_ACTION = '无法连接千问AI平台';
const STREAM_INTERRUPTED_ACTION = '读取千问AI平台的响应时中断';
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

/** 请求超时配置，单位为毫秒；测试时可注入更短的值。 */
export interface QianwenTimeouts {
  /** 普通请求（提交、查询、取消、测试连接）从发起到读完响应的总超时。 */
  readonly requestMs: number;
  /** 流式文本生成的空闲超时：连续这么久没有收到任何数据就中止。 */
  readonly streamIdleMs: number;
}

/** 默认超时：普通请求需要上传 Base64 内联的参考素材，留出余量；流式生成只在长时间无数据时才算超时。 */
export const DEFAULT_QIANWEN_TIMEOUTS: QianwenTimeouts = {
  requestMs: 60_000,
  streamIdleMs: 120_000
};

/** 千问AI平台 HTTP 客户端。 */
export class QianwenApiClient {
  private readonly timeouts: QianwenTimeouts;

  /**
   * @param fetchFunction 发起网络请求的函数，测试时可注入假实现。
   * @param timeouts 超时配置，缺省使用 DEFAULT_QIANWEN_TIMEOUTS。
   */
  constructor(private readonly fetchFunction: FetchFunction = fetch, timeouts: QianwenTimeouts = DEFAULT_QIANWEN_TIMEOUTS) {
    this.timeouts = timeouts;
  }
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
   * 超时按“空闲”计算：从发起请求到收到响应头、以及之后每次等待下一段数据，连续超过 streamIdleMs 没有任何数据就中止；
   * 只要数据持续到达，生成多久都不会超时（文本生成总时长不定，不能套用短的总超时）。
   * @param context 调用凭据与设置；兼容接口的地址由原生接口地址末尾的 /api/v1 替换为 /compatible-mode/v1 得到。
   * @param path 相对兼容接口地址的路径，以 / 开头。
   * @param body 请求体对象，由调用方设置 stream 为 true。
   * @throws ProviderError 网络失败、请求超时、非 2xx 响应，或读取流时中断；调用方主动取消时原样抛出取消异常。
   */
  async *postEventStream(context: ProviderCallContext, path: string, body: unknown): AsyncGenerator<string> {
    const base = readEndpoint(context).replace(new RegExp(QIANWEN_ENDPOINT_PATTERN), COMPATIBLE_MODE_PATH);
    const idle = new IdleTimeout(context.signal, this.timeouts.streamIdleMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      idle.arm();
      const response = await this.fetchFunction(`${base}${path}`, {
        method: 'POST',
        headers: buildHeaders(context, { 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal: idle.signal
      });
      if (!response.ok) {
        throw buildHttpError(response.status, await readJsonObject(response));
      }
      idle.clear();
      if (response.body === null) {
        throw new ProviderError('server', '千问AI平台没有返回内容。');
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        // 只在等待数据时计时；产出事件后调用方处理的时间不算。
        idle.arm();
        const { done, value } = await reader.read();
        idle.clear();
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
      throw toRequestFailure(error, {
        cancelSignal: context.signal,
        timedOutMs: idle.timedOut ? this.timeouts.streamIdleMs : null,
        action: STREAM_INTERRUPTED_ACTION
      });
    } finally {
      idle.clear();
      await reader?.cancel().catch(() => undefined);
    }
  }

  private async send(
    context: ProviderCallContext,
    path: string,
    request: { readonly method: string; readonly body?: string; readonly extraHeaders: Readonly<Record<string, string>> }
  ): Promise<Record<string, unknown>> {
    const endpoint = readEndpoint(context);
    // 默认超时覆盖连接与读取响应体的全过程；调用方传入的取消信号与它合并，任何一个触发都会中止请求。
    const timeout = AbortSignal.timeout(this.timeouts.requestMs);
    const signal = context.signal === undefined ? timeout : AbortSignal.any([context.signal, timeout]);
    try {
      const response = await this.fetchFunction(`${endpoint}${path}`, {
        method: request.method,
        headers: buildHeaders(context, request.extraHeaders),
        body: request.body,
        signal
      });
      const payload = await readJsonObject(response);
      if (!response.ok) {
        throw buildHttpError(response.status, payload);
      }
      return payload;
    } catch (error) {
      throw toRequestFailure(error, {
        cancelSignal: context.signal,
        timedOutMs: timeout.aborted ? this.timeouts.requestMs : null,
        action: CONNECT_FAILED_ACTION
      });
    }
  }
}

/** 流式请求的空闲超时：计时器在等待数据期间运行，超时即中止请求；同时合并调用方的取消信号。 */
class IdleTimeout {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fired = false;
  /** 传给 fetch 的信号：调用方取消或空闲超时任一触发都会中止。 */
  readonly signal: AbortSignal;

  constructor(
    cancelSignal: AbortSignal | undefined,
    private readonly timeoutMs: number
  ) {
    this.signal = cancelSignal === undefined ? this.controller.signal : AbortSignal.any([cancelSignal, this.controller.signal]);
  }

  /** 是否因空闲超时而中止。 */
  get timedOut(): boolean {
    return this.fired;
  }

  /** 开始（或重新开始）计时。 */
  arm(): void {
    this.clear();
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, this.timeoutMs);
  }

  /** 停止计时。 */
  clear(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

/** 请求失败的判断依据。 */
interface RequestFailureContext {
  /** 调用方传入的取消信号。 */
  readonly cancelSignal: AbortSignal | undefined;
  /** 已因超时中止时为超时毫秒数，否则为 null。 */
  readonly timedOutMs: number | null;
  /** 失败说明的固定前缀，如“无法连接千问AI平台”。 */
  readonly action: string;
}

/** 带鉴权的请求头。 */
function buildHeaders(context: ProviderCallContext, extraHeaders: Readonly<Record<string, string>>): Record<string, string> {
  return { Authorization: `Bearer ${context.apiKey}`, ...extraHeaders };
}

/**
 * 把请求过程中的异常转换为要抛出的错误：
 * 已是 ProviderError 的原样返回；调用方主动取消的原样返回（不属于服务商故障）；超时转为可重试的 network 类错误；
 * 其余转为 network 类错误，消息只含固定说明与脱敏摘要，不携带原始异常，避免地址、密钥等经 cause 暴露到界面。
 */
function toRequestFailure(error: unknown, failure: RequestFailureContext): unknown {
  if (error instanceof ProviderError) {
    return error;
  }
  if (failure.cancelSignal?.aborted === true) {
    // 调用方的信号可能是 AbortSignal.timeout（如测试连接自带的超时），其原因为 TimeoutError，按超时处理；其余是主动取消，原样抛出。
    return isTimeoutReason(failure.cancelSignal.reason) ? new ProviderError('network', CALLER_TIMEOUT_MESSAGE) : error;
  }
  if (failure.timedOutMs !== null) {
    return new ProviderError('network', `请求超时：千问AI平台在 ${Math.ceil(failure.timedOutMs / MS_PER_SECOND)} 秒内没有响应。`);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return error;
  }
  return new ProviderError('network', `${failure.action}：${summarizeNetworkError(error)}`);
}

/** 判断信号中止的原因是否为超时（AbortSignal.timeout 触发时为名为 TimeoutError 的异常）。 */
function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

/** 脱敏规则，按顺序应用：把可能含密钥、地址的片段替换为占位文字。 */
const REDACTIONS: ReadonlyArray<readonly [pattern: RegExp, replacement: string]> = [
  [/\bBearer\s+\S+/gi, REDACTED_SECRET],
  [/\b(?:api[_-]?key|access[_-]?key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, REDACTED_SECRET],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, REDACTED_SECRET],
  [/https?:\/\/\S*/gi, REDACTED_ADDRESS],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, REDACTED_ADDRESS],
  [/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/\S*)?/gi, REDACTED_ADDRESS],
  [/\?\S*/g, ''],
  [/[A-Za-z0-9_+/=-]{32,}/g, REDACTED_SECRET]
];

/**
 * 生成网络错误的脱敏摘要：取异常说明，去掉地址、查询串和形如密钥的内容，附上底层错误码（如 ECONNREFUSED），并限制长度。
 * @param error 请求过程中抛出的异常。
 */
function summarizeNetworkError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), raw)
    .replace(/\s+/g, ' ')
    .trim();
  const summary = redacted.length > NETWORK_SUMMARY_MAX_LENGTH ? `${redacted.slice(0, NETWORK_SUMMARY_MAX_LENGTH)}…` : redacted;
  const text = summary === '' ? UNKNOWN_ERROR_TEXT : summary;
  const code = readSystemErrorCode(error);
  return code === null ? text : `${text}（${code}）`;
}

/** 取底层系统错误码（如 ECONNREFUSED、ENOTFOUND），从异常本身或其 cause 中查找；没有时返回 null。 */
function readSystemErrorCode(error: unknown): string | null {
  for (const candidate of [error, error instanceof Error ? error.cause : undefined]) {
    const code = typeof candidate === 'object' && candidate !== null ? (candidate as { code?: unknown }).code : undefined;
    if (typeof code === 'string' && SYSTEM_ERROR_CODE_PATTERN.test(code)) {
      return code;
    }
  }
  return null;
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
