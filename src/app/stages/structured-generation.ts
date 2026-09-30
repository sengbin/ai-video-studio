// ------------------------------------------------------------------------
// 名称：structured-generation.ts
// 说明：结构化生成：调用文本生成端口，解析并校验 JSON 输出，不符合要求时直接失败，不自动重试。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：模型返回 {"refused": "原因"} 视为拒绝；输出不符合要求抛出 InvalidOutputError 并附原始输出，由用户决定重试或重新生成。
// ------------------------------------------------------------------------

import { GeneratedOutputError, TextGenerationError } from '../../domain/errors';
import { TextGenerationPort, TextGenerationRequest } from '../../domain/ports/text-generation-port';
import { parseModelJson } from '../../domain/rules/json-output';

/** 模型输出不符合格式或规则；rawOutput 为原始输出，便于排查。 */
export class InvalidOutputError extends Error {
  constructor(readonly issues: readonly string[], readonly rawOutput: string) {
    super(`模型输出不符合要求：${issues.join('；')}`);
    this.name = 'InvalidOutputError';
  }
}

/** 结构化生成的选项。 */
export interface StructuredGenerationOptions {
  readonly signal?: AbortSignal;
}

/**
 * 生成并解析结构化输出。
 * @param port 文本生成端口。
 * @param request 请求内容。
 * @param parse 把解析后的 JSON 校验并转换为结果；不符合要求时抛出 GeneratedOutputError。
 * @param options 取消信号。
 * @throws TextGenerationError 调用失败或模型拒绝生成。
 * @throws InvalidOutputError 输出不符合要求。
 */
export async function generateStructured<T>(
  port: TextGenerationPort,
  request: TextGenerationRequest,
  parse: (json: unknown) => T,
  options: StructuredGenerationOptions = {}
): Promise<T> {
  const rawOutput = await port.generate(request, { signal: options.signal });
  try {
    const json = parseModelJson(rawOutput);
    if (typeof json === 'object' && json !== null && 'refused' in json && typeof json.refused === 'string') {
      throw new TextGenerationError('refused', `模型拒绝生成：${json.refused}`);
    }
    return parse(json);
  } catch (error) {
    if (error instanceof GeneratedOutputError) {
      throw new InvalidOutputError(error.issues, rawOutput);
    }
    throw error;
  }
}
