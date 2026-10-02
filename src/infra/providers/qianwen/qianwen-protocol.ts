// ------------------------------------------------------------------------
// 名称：qianwen-protocol.ts
// 说明：千问AI平台各类型适配器共用的协议部分：异步任务的提交头、状态映射与结果封装，测试连接的探测路径，Base64 素材编码与校验，模型专有参数的校验与转换。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：视频、图像生成都走“提交任务 + GET /tasks/{id} 轮询”；音频接口是同步的，不使用任务状态部分，但测试连接同样借用任务查询接口做探测（同一接口地址、同一访问密钥）。
// ------------------------------------------------------------------------

import { ProviderError } from '../../../domain/errors';
import { MediaInput, RemoteJobState, RemoteJobStatus } from '../../../domain/ports/provider-adapters';
import { classifyErrorCode } from './qianwen-api-client';

/** 异步提交必须带的请求头。 */
export const ASYNC_HEADERS = { 'X-DashScope-Async': 'enable' };

/** 查询任务的接口路径，后接任务标识。 */
export const QUERY_TASK_PATH = '/tasks';

/** 测试连接时查询的任务路径：任务标识不会存在，平台应返回带错误码的业务错误。 */
export const CONNECTION_PROBE_PATH = `${QUERY_TASK_PATH}/00000000-0000-0000-0000-000000000000`;

/** 任务状态与统一状态的对应。 */
const TASK_STATUSES: Readonly<Record<string, RemoteJobStatus>> = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELED: 'canceled',
  UNKNOWN: 'expired'
};

/** 模型专有参数的声明：请求体中的键，以及允许的取值。 */
export interface ExtraParamSpec {
  readonly apiKey: string;
  readonly allowed: readonly (string | boolean)[];
}

/** 把未知值当作对象读取；不是对象时返回空对象。 */
export function readObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 把素材转换为 Base64 内联地址：data:{类型};base64,{内容}。 */
export function toDataUri(media: MediaInput): string {
  return `data:${media.mimeType};base64,${Buffer.from(media.data).toString('base64')}`;
}

/** 校验一组素材的类型与大小。 */
export function validateMediaFiles(files: readonly MediaInput[], mimePrefix: string, label: string, maxBytes: number): string[] {
  const issues: string[] = [];
  for (const file of files) {
    if (!file.mimeType.startsWith(mimePrefix)) {
      issues.push(`${label}素材的类型必须以 ${mimePrefix} 开头（当前 ${file.mimeType}）。`);
    }
    if (file.data.byteLength === 0 || file.data.byteLength > maxBytes) {
      issues.push(`${label}素材大小必须在 1 字节到 ${maxBytes / 1024 / 1024} MB 之间。`);
    }
  }
  return issues;
}

/** 校验模型专有参数：只允许已声明的键，且取值必须在允许范围内。 */
export function validateExtraParams(extraParams: Readonly<Record<string, unknown>>, specs: Readonly<Record<string, ExtraParamSpec>>): string[] {
  const issues: string[] = [];
  for (const [key, value] of Object.entries(extraParams)) {
    const spec = specs[key];
    if (spec === undefined) {
      issues.push(`不支持的模型参数：${key}。`);
    } else if (!spec.allowed.some((candidate) => candidate === value)) {
      const isSwitch = spec.allowed.every((candidate) => typeof candidate === 'boolean');
      issues.push(isSwitch ? `模型参数 ${key} 必须是开或关。` : `模型参数 ${key} 必须是以下之一：${spec.allowed.join('、')}。`);
    }
  }
  return issues;
}

/** 把已通过校验的模型专有参数转换为请求体中的键值。 */
export function mapExtraParams(extraParams: Readonly<Record<string, unknown>>, specs: Readonly<Record<string, ExtraParamSpec>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(extraParams).map(([key, value]) => [specs[key].apiKey, value]));
}

/**
 * 从提交响应中读取任务标识。
 * @throws ProviderError 响应没有任务标识。
 */
export function readTaskId(response: Record<string, unknown>): string {
  const taskId = readObject(response.output).task_id;
  if (typeof taskId !== 'string' || taskId === '') {
    throw new ProviderError('server', '千问AI平台没有返回任务标识。');
  }
  return taskId;
}

/**
 * 把查询响应的 output 转换为统一的任务状态：成功时用 readResult 读取结果，失败时带错误分类，其余状态不带结果。
 * @param output 查询响应中的 output 对象。
 * @param readResult 读取成功结果；结果缺失时应抛出 ProviderError。
 * @throws ProviderError 状态无法识别，或成功却读不到结果。
 */
export function buildTaskState<TResult>(output: Record<string, unknown>, readResult: () => TResult): RemoteJobState<TResult> {
  const status = typeof output.task_status === 'string' ? TASK_STATUSES[output.task_status] : undefined;
  if (status === undefined) {
    throw new ProviderError('server', `千问AI平台返回了无法识别的任务状态：${String(output.task_status)}。`);
  }
  if (status === 'succeeded') {
    return { status, result: readResult(), errorCategory: null, errorCode: null, errorMessage: null };
  }
  if (status === 'failed') {
    const code = typeof output.code === 'string' ? output.code : null;
    const message = typeof output.message === 'string' ? output.message : null;
    return { status, result: null, errorCategory: classifyErrorCode(code) ?? 'server', errorCode: code, errorMessage: message };
  }
  return { status, result: null, errorCategory: null, errorCode: null, errorMessage: null };
}
