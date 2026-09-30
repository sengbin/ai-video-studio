// ------------------------------------------------------------------------
// 名称：copilot-text-generation.ts
// 说明：文本生成端口的 Copilot 实现：通过 VS Code 语言模型接口（vscode.lm）选择模型并发送请求。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：首次调用时 VS Code 会向用户请求授权，因此生成必须由用户操作触发；系统段与用户段合并为一条用户消息发送。
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

/** 提供当前设置中的模型家族；空串表示自动选择。 */
export interface CopilotModelSettings {
  getModelFamily(): string;
}

/**
 * 读取模型是否支持图片输入。类型声明里没有这个字段，按运行时对象上可能出现的两种命名探测；
 * 探测不到时按不支持处理，避免模型忽略图片后凭空描述。
 */
function readImageInputSupport(model: vscode.LanguageModelChat): boolean {
  const capabilities = (model as unknown as { capabilities?: Record<string, unknown> }).capabilities;
  return capabilities?.imageInput === true || capabilities?.supportsImageToText === true;
}

/** 基于 vscode.lm 的 Copilot 文本生成。 */
export class CopilotTextGeneration implements TextGenerationPort {
  private model: vscode.LanguageModelChat | undefined;

  constructor(private readonly settings: CopilotModelSettings) {}

  async resolveModel(): Promise<TextModelInfo> {
    const model = await this.selectModel();
    this.model = model;
    return {
      id: `${model.vendor}/${model.family}`,
      maxInputTokens: model.maxInputTokens,
      supportsImageInput: readImageInputSupport(model)
    };
  }

  async countTokens(text: string): Promise<number> {
    try {
      return await (await this.currentModel()).countTokens(text);
    } catch (error) {
      throw mapLanguageModelError(error);
    }
  }

  async generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<string> {
    const model = await this.currentModel();
    const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelDataPart)[] = [
      new vscode.LanguageModelTextPart(`${request.system}${SYSTEM_SEPARATOR}${request.user}`),
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
        { justification: REQUEST_JUSTIFICATION },
        cancellation.token
      );
      let text = '';
      for await (const chunk of response.text) {
        text += chunk;
      }
      return text;
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
      const family = this.settings.getModelFamily();
      let models = family === '' ? [] : await vscode.lm.selectChatModels({ vendor: COPILOT_VENDOR, family });
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
