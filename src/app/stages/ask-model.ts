// ------------------------------------------------------------------------
// 名称：ask-model.ts
// 说明：阶段工作流共用的一次模型提问：渲染模板、检查输入是否超出模型上限、调用结构化生成。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：取消信号已触发时不发送请求；输入超出上限时失败并给出调整建议，不自动缩减。
// ------------------------------------------------------------------------

import { TextGenerationError } from '../../domain/errors';
import { PromptTemplates } from '../../domain/ports/prompt-templates';
import { ImageInput, OutputTool } from '../../domain/ports/text-generation-port';
import { renderTemplate } from './prompt-templates';
import { StageContext } from './stage-workflow';
import { generateStructured } from './structured-generation';

/** 单次请求的输入 token 不得超过模型上限的这个比例，给输出和系统段留余量。 */
const INPUT_BUDGET_RATIO = 0.8;

/** 一次提问需要的上下文：阶段工作流上下文，或只含模型、文本端口与取消信号的最小上下文。 */
export type AskContext = Pick<StageContext, 'model' | 'text' | 'signal'>;

/** 一次提问的选项。 */
export interface AskOptions {
  readonly images?: readonly ImageInput[];
  /** 输入超出模型上限时给用户的建议。 */
  readonly overflowHint: string;
  /** 用于强制结构化输出的工具。 */
  readonly tool: OutputTool;
}

/**
 * 用模板向模型提问并校验结果。
 * @param context 工作流上下文，提供模型、文本生成端口与取消信号。
 * @param prompts 提示词模板来源，系统段固定取 system 模板。
 * @param template 用户段模板名称。
 * @param variables 模板变量。
 * @param parse 把模型提交的结果对象校验并转换为结果。
 * @param options 图片、超限建议与输出工具。
 * @throws TextGenerationError 已取消、输入超出模型上限，或调用失败。
 * @throws InvalidOutputError 输出不符合要求。
 */
export async function askModel<T>(
  context: AskContext,
  prompts: PromptTemplates,
  template: string,
  variables: Readonly<Record<string, string>>,
  parse: (json: unknown) => T,
  options: AskOptions
): Promise<T> {
  if (context.signal.aborted) {
    throw new TextGenerationError('canceled', '已取消。');
  }
  const system = prompts.get('system');
  const user = renderTemplate(prompts.get(template), variables);
  const tokens = await context.text.countTokens(`${system}\n${user}`);
  if (tokens > context.model.maxInputTokens * INPUT_BUDGET_RATIO) {
    throw new TextGenerationError('failed', `本次请求约 ${tokens} 个 token，超出模型输入上限。${options.overflowHint}`);
  }
  return generateStructured(context.text, { system, user, images: options.images, tool: options.tool }, parse, {
    signal: context.signal
  });
}
