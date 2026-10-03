// ------------------------------------------------------------------------
// 名称：copilot-text-generation.ts
// 说明：文本生成端口的 Copilot 实现：通过 VS Code 语言模型接口（vscode.lm）选择模型并发送请求。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：首次调用时 VS Code 会向用户请求授权，因此生成必须由用户操作触发；系统段与用户段合并为一条用户消息发送；必须用 toolMode.Required 强制模型通过输出工具返回结构化结果，不支持工具调用的模型不可用。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { TextGenerationError } from '../../domain/errors';
import {
  TextGenerationOptions,
  TextGenerationPort,
  TextGenerationRequest,
  TextModelInfo
} from '../../domain/ports/text-generation-port';
import { mapLanguageModelError } from './copilot-error-mapping';

const COPILOT_VENDOR = 'copilot';
const REQUEST_JUSTIFICATION = '生成创作内容并保存到本地数据库，内容由用户检查确认后才会使用。';
const SYSTEM_SEPARATOR = '\n\n---\n\n';
/** 输出工具追加在用户段末尾的说明。 */
const TOOL_INSTRUCTION = (name: string): string => `\n\n请调用工具 ${name} 提交结果，工具参数就是上面要求的字段。`;

/** 基于 vscode.lm 的 Copilot 文本生成；每个实例固定使用一个模型家族。 */
export class CopilotTextGeneration implements TextGenerationPort {
  private model: vscode.LanguageModelChat | undefined;

  /**
   * @param family 模型家族；空串表示自动选择，所选家族不可用时回退到任意可用的 Copilot 模型。
   */
  constructor(private readonly family: string = '') {}

  async resolveModel(): Promise<TextModelInfo> {
    const model = await this.selectModel();
    this.model = model;
    return {
      id: `${model.vendor}/${model.family}`,
      maxInputTokens: model.maxInputTokens
    };
  }

  async countTokens(text: string): Promise<number> {
    try {
      return await (await this.currentModel()).countTokens(text);
    } catch (error) {
      throw mapLanguageModelError(error);
    }
  }

  async generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<unknown> {
    const model = await this.currentModel();
    const tool = request.tool;
    const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [
      new vscode.LanguageModelTextPart(`${request.system}${SYSTEM_SEPARATOR}${request.user}${TOOL_INSTRUCTION(tool.name)}`),
      ...(request.images ?? []).map((image) => vscode.LanguageModelDataPart.image(image.data, image.mimeType))
    ];

    const cancellation = new vscode.CancellationTokenSource();
    const signal = options?.signal;
    const abort = () => cancellation.cancel();
    if (signal?.aborted) {
      cancellation.cancel();
    }
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(parts)],
        {
          justification: REQUEST_JUSTIFICATION,
          tools: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }],
          toolMode: vscode.LanguageModelChatToolMode.Required
        },
        cancellation.token
      );
      let toolInput: object | undefined;
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelToolCallPart && part.name === tool.name) {
          toolInput = part.input;
        }
      }
      if (toolInput === undefined) {
        throw new TextGenerationError('failed', '模型没有通过工具返回结果，当前模型可能不支持工具调用，请在“模型设置”中更换文本模型。');
      }
      return toolInput;
    } catch (error) {
      throw mapLanguageModelError(error);
    } finally {
      signal?.removeEventListener('abort', abort);
      cancellation.dispose();
    }
  }

  /** 取当前模型；还没解析过时先解析。 */
  private async currentModel(): Promise<vscode.LanguageModelChat> {
    return this.model ?? (await this.selectModel());
  }

  /** 按设置选择模型：所选家族不可用时回退到任意可用的 Copilot 模型。 */
  private async selectModel(): Promise<vscode.LanguageModelChat> {
    try {
      let models = this.family === '' ? [] : await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR, family: this.family });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR });
      }
      if (models.length === 0) {
        throw new TextGenerationError('unavailable', '没有可用的 Copilot 模型，请确认已安装并登录 GitHub Copilot。');
      }
      return models[0];
    } catch (error) {
      throw mapLanguageModelError(error);
    }
  }
}
