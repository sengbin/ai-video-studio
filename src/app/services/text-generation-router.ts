// ------------------------------------------------------------------------
// 名称：text-generation-router.ts
// 说明：文本生成的路由实现：按作品的单独选择、全局默认的顺序决定使用 Copilot 的某个模型还是服务商的某个文本模型。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：每次 resolveModel 重新按当时的设置选定模型，之后同一个端口的 countTokens 与 generate 沿用该选择，不同作品的生成互不影响；选择的模型已不可用（被停用、Copilot 已关闭、Copilot 没有可用模型或所选家族不存在）时依次回退到全局默认、Copilot 自动（仅当 Copilot 确有可用模型）、第一个可用的服务商文本模型；Copilot 是否可用以其 resolveModel 抛出 unavailable 为准，其他错误（授权、限流等）不回退；服务商调用失败统一转换为 TextGenerationError。
// ------------------------------------------------------------------------

import { ProviderError, TextGenerationError } from '../../domain/errors';
import { UsableModel } from '../../domain/models/model-provider';
import { ResolvedTextCall } from '../../domain/ports/provider-adapters';
import {
  TextGenerationOptions,
  TextGenerationPort,
  TextGenerationRequest,
  TextGenerationSource,
  TextModelInfo
} from '../../domain/ports/text-generation-port';
import { TextGenerationSettingsStore } from '../../domain/ports/text-generation-settings-store';
import { WorkTextModelRepository } from '../../domain/ports/work-text-model-repository';
import { estimateTokens } from '../../domain/rules/token-estimate';
import { copilotModelKey, parseTextModelKey, providerModelKey } from '../../domain/rules/text-model-selection';

/** 没有任何可用的文本模型时的提示。 */
export const NO_TEXT_ENGINE_MESSAGE = '没有可用的文本模型：请到“模型设置”启用 Copilot，或启用一个千问AI平台的文本模型。';

/** Copilot 已启用但没有可用的模型、又没有可回退的服务商文本模型时，追加在 Copilot 不可用原因之后的提示。 */
export const NO_PROVIDER_FALLBACK_NOTE = '同时没有可回退的千问AI平台文本模型，请到“模型设置”启用一个。';

/** 路由依赖的服务商能力：列出可选的文本模型、取得调用文本模型所需的内容。 */
export interface TextProviderCalls {
  listSelectableTextModels(): UsableModel[];
  resolveTextCall(modelId: number): Promise<ResolvedTextCall>;
}

/** 路由的依赖。 */
export interface TextGenerationRouterDependencies {
  readonly settings: Pick<TextGenerationSettingsStore, 'read'>;
  /** 创建固定使用某个 Copilot 模型家族的端口；空串表示自动选择。 */
  readonly createCopilot: (family: string) => TextGenerationPort;
  readonly providers: TextProviderCalls;
  readonly workModels: Pick<WorkTextModelRepository, 'find'>;
}

/** 选定的引擎：Copilot 的某个家族，或服务商的某个文本模型。 */
type ChosenModel = { readonly kind: 'copilot'; readonly family: string } | { readonly kind: 'provider'; readonly model: UsableModel };

/** 选定并已解析的引擎，之后的调用沿用。 */
type ActiveEngine =
  | { readonly kind: 'copilot'; readonly port: TextGenerationPort }
  | { readonly kind: 'provider'; readonly call: ResolvedTextCall };

/** 按设置选择 Copilot 或服务商文本模型的文本生成来源。 */
export class TextGenerationRouter implements TextGenerationSource {
  constructor(private readonly dependencies: TextGenerationRouterDependencies) {}

  forWork(workId: number | null): TextGenerationPort {
    return new RoutedTextPort(this.dependencies, workId);
  }
}

/** 绑定到一个作品的文本生成端口。 */
class RoutedTextPort implements TextGenerationPort {
  private active: ActiveEngine | undefined;

  constructor(
    private readonly dependencies: TextGenerationRouterDependencies,
    private readonly workId: number | null
  ) {}

  async resolveModel(): Promise<TextModelInfo> {
    let copilotUnavailable: TextGenerationError | undefined;
    for (const chosen of this.candidates()) {
      if (chosen.kind === 'provider') {
        return this.resolveProvider(chosen.model);
      }
      const port = this.dependencies.createCopilot(chosen.family);
      try {
        const info = await port.resolveModel();
        this.active = { kind: 'copilot', port };
        return info;
      } catch (error) {
        // 只有“Copilot 没有可用模型 / 所选家族不存在”才按回退顺序尝试下一个；授权、限流等其他错误如实抛出。
        if (error instanceof TextGenerationError && error.category === 'unavailable') {
          copilotUnavailable = error;
          continue;
        }
        throw error;
      }
    }
    throw new TextGenerationError(
      'unavailable',
      copilotUnavailable === undefined ? NO_TEXT_ENGINE_MESSAGE : `${copilotUnavailable.message}${NO_PROVIDER_FALLBACK_NOTE}`,
      copilotUnavailable === undefined ? undefined : { cause: copilotUnavailable }
    );
  }

  /** 解析服务商文本模型并设为当前引擎。 */
  private async resolveProvider(model: UsableModel): Promise<TextModelInfo> {
    let call: ResolvedTextCall;
    try {
      call = await this.dependencies.providers.resolveTextCall(model.model.id);
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
    return engine.kind === 'copilot' ? engine.port.countTokens(text) : estimateTokens(text);
  }

  async generate(request: TextGenerationRequest, options?: TextGenerationOptions): Promise<unknown> {
    const engine = await this.currentEngine();
    if (engine.kind === 'copilot') {
      return engine.port.generate(request, options);
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

  /**
   * 按“作品的选择、全局默认、Copilot 自动、第一个可用的服务商文本模型”的顺序列出候选（已去重）。
   * Copilot 的候选是否真的可用要等解析时才知道，解析失败（unavailable）后由 resolveModel 继续尝试后面的候选。
   */
  private candidates(): ChosenModel[] {
    const { settings, providers, workModels } = this.dependencies;
    const { copilotEnabled, defaultModel } = settings.read();
    const selectable = providers.listSelectableTextModels();
    const providerKeys = new Map(selectable.map((item) => [providerModelKey(item.providerCode, item.model.code), item]));

    const toChosen = (key: string | null): ChosenModel | undefined => {
      const selection = key === null ? undefined : parseTextModelKey(key);
      if (selection === undefined) {
        return undefined;
      }
      if (selection.engine === 'copilot') {
        return copilotEnabled ? { kind: 'copilot', family: selection.family } : undefined;
      }
      const model = providerKeys.get(providerModelKey(selection.providerCode, selection.modelCode));
      return model === undefined ? undefined : { kind: 'provider', model };
    };

    const workKey = this.workId === null ? null : workModels.find(this.workId);
    const keys = [workKey, defaultModel, copilotEnabled ? copilotModelKey('') : null, [...providerKeys.keys()][0] ?? null];
    const candidates = new Map<string, ChosenModel>();
    for (const key of keys) {
      const chosen = toChosen(key);
      if (key !== null && chosen !== undefined && !candidates.has(key)) {
        candidates.set(key, chosen);
      }
    }
    return [...candidates.values()];
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
