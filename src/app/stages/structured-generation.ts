// ------------------------------------------------------------------------
// 名称：structured-generation.ts
// 说明：结构化生成：调用文本生成端口，解析并校验 JSON 输出，校验失败时把问题反馈给模型自动重试。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：模型返回 {"refused": "原因"} 视为拒绝，不重试；重试次数用尽抛出 OutputRetryExhaustedError 并附原始输出。
// ------------------------------------------------------------------------

import { GeneratedOutputError, TextGenerationError } from '../../domain/errors';
import { TextGenerationPort, TextGenerationRequest } from '../../domain/ports/text-generation-port';
import { parseModelJson } from '../../domain/rules/json-output';

/** 默认最多尝试次数：首次加两次修正重试。 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** 多次重试后输出仍不符合要求；rawOutput 为最后一次的原始输出，便于排查。 */
export class OutputRetryExhaustedError extends Error {
  constructor(readonly issues: readonly string[], readonly rawOutput: string) {
    super(`模型输出多次不符合要求：${issues.join('；')}`);
    this.name = 'OutputRetryExhaustedError';
  }
}

/** 结构化生成的选项。 */
export interface StructuredGenerationOptions {
  readonly signal?: AbortSignal;
  readonly maxAttempts?: number;
}

/** 生成一个重试用的用户段：原请求加上一次输出的问题说明。 */
function withFeedback(user: string, issues: readonly string[]): string {
  const lines = issues.map((issue) => `- ${issue}`).join('\n');
  return `${user}\n\n上一次输出存在以下问题，请修正后重新输出完整的 JSON：\n${lines}`;
}

/**
 * 生成并解析结构化输出。
 * @param port 文本生成端口。
 * @param request 请求内容。
 * @param parse 把解析后的 JSON 校验并转换为结果；不符合要求时抛出 GeneratedOutputError。
 * @param options 取消信号与最大尝试次数。
 * @throws TextGenerationError 调用失败或模型拒绝生成。
 * @throws OutputRetryExhaustedError 重试用尽后输出仍不符合要求。
 */
export async function generateStructured<T>(
  port: TextGenerationPort,
  request: TextGenerationRequest,
  parse: (json: unknown) => T,
  options: StructuredGenerationOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  let user = request.user;
  let rawOutput = '';
  let issues: readonly string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    rawOutput = await port.generate({ ...request, user }, { signal: options.signal });
    try {
      const json = parseModelJson(rawOutput);
      if (typeof json === 'object' && json !== null && 'refused' in json && typeof json.refused === 'string') {
        throw new TextGenerationError('refused', `模型拒绝生成：${json.refused}`);
      }
      return parse(json);
    } catch (error) {
      if (!(error instanceof GeneratedOutputError)) {
        throw error;
      }
      issues = error.issues;
      user = withFeedback(request.user, issues);
    }
  }
  throw new OutputRetryExhaustedError(issues, rawOutput);
}
