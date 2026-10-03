// ------------------------------------------------------------------------
// 名称：text-generation-router.ts
// 说明：文本生成端口的路由实现：按设置选择生成文本的引擎——启用 Copilot 时交给 Copilot，否则使用已启用的千问AI平台文本模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：每次 resolveModel 重新按当前设置选择引擎，之后的 countTokens 与 generate 沿用该选择；多个文本模型同时启用时使用列表中靠前的一个；服务商调用失败统一转换为 TextGenerationError。
// ------------------------------------------------------------------------

import { ProviderError, TextGenerationError } from '../../domain/errors';
import { ModelRecord } from '../../domain/models/model-provider';
import { ResolvedTextCall } from '../../domain/ports/provider-adapters';
import {
  TextGenerationOptions,
  TextGenerationPort,
  TextGenerationRequest,
  TextModelInfo
} from '../../domain/ports/text-generation-port';
import { estimateTokens } from '../../domain/rules/token-estimate';

/** 未启用任何文本引擎时的提示。 */
export const NO_TEXT_ENGINE_MESSAGE = '没有可用的文本生成模型：请到“模型设置”启用 Copilot，或启用一个千问AI平台的文本模型。';

/** 路由依赖的设置：是否使用 Copilot。 */
export interface TextEngineSettings {
  isCopilotEnabled(): boolean;
}

/** 路由依赖的服务商能力：列出文本模型、取得调用文本模型所需的内容。 */
export interface TextProviderCalls {
  listTextModels(): ModelRecord[];
  resolveTextCall(modelId: number): Promise<ResolvedTextCall>;
}

/** 路由的依赖。 */
export interface TextGenerationRouterDependencies {
  readonly settings: TextEngineSettings;
  readonly copilot: TextGenerationPort;
  readonly providers: TextProviderCalls;
}

/** 当前选定的引擎：Copilot，或某个服务商文本模型的调用。 */
type ActiveEngine = { readonly kind: 'copilot' } | { readonly kind: 'provider'; readonly call: ResolvedTextCall };

/** 按设置在 Copilot 与服务商文本模型之间选择的文本生成端口。 */
export class TextGenerationRouter implements TextGenerationPort {
  private active: ActiveEngine | undefined;

  constructor(private readonly dependencies: TextGenerationRouterDependencies) {}

  async resolveModel(): Promise<TextModelInfo> {
    const { settings, copilot, providers } = this.dependencies;
    if (settings.isCopilotEnabled()) {
      const info = await copilot.resolveModel();
      this.active = { kind: 'copilot' };
      return info;
    }

    const model = providers.listTextModels().find((candidate) => candidate.isEnabled);
    if (model === undefined) {
      throw new TextGenerationError('unavailable', NO_TEXT_ENGINE_MESSAGE);
    }
    let call: ResolvedTextCall;
    try {
      call = await providers.resolveTextCall(model.id);
    } catch (error) {
      throw mapProviderError(error);
    }
    const capability = call.adapter.getCapability(call.modelCode);
    if (capability === undefined) {
      throw new TextGenerationError('unavailable', `文本模型 ${call.modelCode} 已不存在，请在“模型设置”中重新选择。`);
    }
    this.active = { kind: 'provider', call };
    return {
      id: `${call.adapter.provider.code}/${call.modelCode}`,
      maxInputTokens: capability.contextTokens - capability.maxOutputTokens
    };
  }

  async countTokens(text: string): Promise<number> {
    const engine = await this.currentEngine();
    return engine.kind === 'copilot' ? this.dependencies.copilot.countTokens(text) : estimateTokens(text);
  }

  async generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<unknown> {
    const engine = await this.currentEngine();
    if (engine.kind === 'copilot') {
      return this.dependencies.copilot.generate(request, options);
    }
    const { adapter, modelCode, context } = engine.call;
    try {
      return await adapter.generate(modelCode, request, { ...context, signal: options?.signal });
    } catch (error) {
      throw mapProviderError(error);
    }
  }

  /** 取当前引擎；还没有选择过时先按设置选择。 */
  private async currentEngine(): Promise<ActiveEngine> {
    if (this.active === undefined) {
      await this.resolveModel();
    }
    return this.active as ActiveEngine;
  }
}

/** 把服务商调用的失败转换为文本生成错误：用户可读的原因直接沿用。 */
function mapProviderError(error: unknown): TextGenerationError {
  if (error instanceof TextGenerationError) {
    return error;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new TextGenerationError('canceled', '已取消。', { cause: error });
  }
  if (error instanceof ProviderError) {
    switch (error.category) {
      case 'auth':
        return new TextGenerationError('not_authorized', error.message, { cause: error });
      case 'rate_limited':
        return new TextGenerationError('rate_limited', error.message, { cause: error });
      case 'content_rejected':
        return new TextGenerationError('refused', error.message, { cause: error });
      case 'invalid_request':
        return new TextGenerationError('failed', error.message, { cause: error });
      default:
        return new TextGenerationError('unavailable', error.message, { cause: error });
    }
  }
  return new TextGenerationError('failed', `调用文本模型失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}
