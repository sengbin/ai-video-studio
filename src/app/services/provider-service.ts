// ------------------------------------------------------------------------
// 名称：provider-service.ts
// 说明：模型服务商应用服务：把适配器声明的服务商与模型同步到数据库，整理设置页视图，并校验后保存启用状态、设置、访问密钥和模型开关。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；密钥只经 SecretStore 保存和读取，不进入任何视图；时钟可注入以便测试。
// ------------------------------------------------------------------------

import { NotFoundError, ProviderError } from '../../domain/errors';
import { MODEL_KIND_LABELS, ModelKind } from '../../domain/models/model-capability';
import {
  ModelDescriptor,
  ModelRecord,
  ModelView,
  ProviderDescriptor,
  ProviderRecord,
  ProviderView,
  UsableModel
} from '../../domain/models/model-provider';
import { ResolvedVideoCall } from '../../domain/ports/provider-adapters';
import { ProviderRegistry } from '../../domain/ports/provider-registry';
import { ProviderRepository } from '../../domain/ports/provider-repository';
import { SecretStore } from '../../domain/ports/secret-store';
import { summarizeCapability } from '../../domain/rules/model-capability-rules';
import {
  normalizeProviderSettings,
  providerApiKeySecretKey,
  readApiKeyInput,
  readModelEnabledInput,
  readProviderId,
  readProviderUpdate,
  resolveProviderSettings
} from '../../domain/rules/provider-rules';

/** 服务商应用服务的依赖。 */
export interface ProviderServiceDependencies {
  readonly repository: ProviderRepository;
  readonly registry: ProviderRegistry;
  readonly secrets: SecretStore;
  /** 返回当前时间的函数，测试时可注入固定时间。 */
  readonly now?: () => Date;
}

/** 模型服务商应用服务。 */
export class ProviderService {
  private readonly repository: ProviderRepository;
  private readonly registry: ProviderRegistry;
  private readonly secrets: SecretStore;
  private readonly now: () => Date;

  constructor(dependencies: ProviderServiceDependencies) {
    this.repository = dependencies.repository;
    this.registry = dependencies.registry;
    this.secrets = dependencies.secrets;
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * 把注册表中适配器声明的服务商与模型同步到数据库，扩展激活时调用一次：
   * 新服务商按默认设置加入；已有服务商和模型更新名称与能力，保留用户的启用状态；适配器不再提供的模型被停用。
   * @throws Error 同一服务商的两个适配器声明了相同的模型代码。
   */
  syncCatalog(): void {
    const timestamp = this.timestamp();
    for (const descriptor of this.registry.listProviders()) {
      const models: ModelDescriptor[] = [];
      for (const adapter of this.registry.listAdapters(descriptor.code)) {
        models.push(...adapter.listModels());
      }
      const codes = models.map((model) => model.code);
      if (new Set(codes).size !== codes.length) {
        throw new Error(`服务商 ${descriptor.code} 的模型代码重复。`);
      }

      const existing = this.repository.findProviderByCode(descriptor.code);
      let provider: ProviderRecord;
      if (existing === undefined) {
        provider = this.repository.insertProvider(
          { code: descriptor.code, displayName: descriptor.displayName, settings: resolveProviderSettings(descriptor.settingFields, {}) },
          timestamp
        );
      } else {
        this.repository.updateProviderName(existing.id, descriptor.displayName, timestamp);
        provider = existing;
      }
      for (const model of models) {
        this.repository.upsertModel(provider.id, model, timestamp);
      }
      this.repository.disableModelsExcept(provider.id, codes);
    }
  }

  /** 列出设置页展示的全部服务商；只包含当前有适配器的服务商。 */
  async listViews(): Promise<ProviderView[]> {
    const views: ProviderView[] = [];
    for (const provider of this.repository.listProviders()) {
      const descriptor = this.registry.findProvider(provider.code);
      if (descriptor !== undefined) {
        views.push(await this.buildView(provider, descriptor));
      }
    }
    return views;
  }

  /**
   * 修改服务商的启用状态或设置项，返回修改后的视图。
   * @param rawInput 界面提交的原始内容：providerId，以及 isEnabled、settings 中至少一项。
   * @throws ValidationError 内容不合法；设置项错误以设置键定位。
   * @throws NotFoundError 服务商不存在。
   */
  async updateProvider(rawInput: unknown): Promise<ProviderView> {
    const input = readProviderUpdate(rawInput);
    const { provider, descriptor } = this.requireProvider(input.providerId);
    const settings =
      input.rawSettings === undefined
        ? undefined
        : {
            ...resolveProviderSettings(descriptor.settingFields, provider.settings),
            ...normalizeProviderSettings(input.rawSettings, descriptor.settingFields)
          };
    const updated = this.repository.updateProvider(provider.id, { isEnabled: input.isEnabled, settings }, this.timestamp());
    return this.buildView(updated ?? provider, descriptor);
  }

  /**
   * 保存（或更换）服务商的访问密钥，返回修改后的视图。
   * @param rawInput 界面提交的原始内容：providerId 与 apiKey。
   * @throws ValidationError 密钥为空、含空白或过长，错误以 apiKey 定位。
   * @throws NotFoundError 服务商不存在。
   */
  async setApiKey(rawInput: unknown): Promise<ProviderView> {
    const { providerId, apiKey } = readApiKeyInput(rawInput);
    const { provider, descriptor } = this.requireProvider(providerId);
    await this.secrets.set(providerApiKeySecretKey(provider.code), apiKey);
    return this.buildView(provider, descriptor);
  }

  /**
   * 清除服务商的访问密钥，返回修改后的视图。
   * @param rawInput 界面提交的原始内容：providerId。
   * @throws NotFoundError 服务商不存在。
   */
  async clearApiKey(rawInput: unknown): Promise<ProviderView> {
    const { provider, descriptor } = this.requireProvider(readProviderId(rawInput));
    await this.secrets.delete(providerApiKeySecretKey(provider.code));
    return this.buildView(provider, descriptor);
  }

  /**
   * 设置模型是否可选，返回所属服务商修改后的视图。
   * @param rawInput 界面提交的原始内容：modelId 与 isEnabled。
   * @throws ValidationError 内容不合法。
   * @throws NotFoundError 模型或其服务商不存在。
   */
  async setModelEnabled(rawInput: unknown): Promise<ProviderView> {
    const { modelId, isEnabled } = readModelEnabledInput(rawInput);
    const model = this.repository.findModelById(modelId);
    if (model === undefined) {
      throw new NotFoundError(`模型 ${modelId} 不存在。`);
    }
    const { provider, descriptor } = this.requireProvider(model.providerId);
    this.repository.setModelEnabled(modelId, isEnabled);
    return this.buildView(provider, descriptor);
  }

  /**
   * 列出某类型当前可以实际使用的模型：模型和服务商都已启用，且服务商已配置访问密钥。
   * @param kind 模型类型。
   */
  async listUsableModels(kind: ModelKind): Promise<UsableModel[]> {
    const usable: UsableModel[] = [];
    for (const provider of this.repository.listProviders()) {
      if (!provider.isEnabled || this.registry.find(kind, provider.code) === undefined || !(await this.hasApiKey(provider.code))) {
        continue;
      }
      for (const model of this.repository.listModels({ providerId: provider.id, kind })) {
        if (model.isEnabled) {
          usable.push({ model, providerCode: provider.code, providerName: provider.displayName });
        }
      }
    }
    return usable;
  }

  /**
   * 取得调用某个视频模型所需的适配器、访问密钥和服务商设置，供生成队列在每次提交与查询前调用。
   * @param modelId 模型标识。
   * @throws ProviderError 模型不存在或不是视频模型、模型或服务商已停用、没有适配器，或没有配置访问密钥（分类均为鉴权或参数）。
   */
  async resolveVideoCall(modelId: number): Promise<ResolvedVideoCall> {
    const model = this.repository.findModelById(modelId);
    const provider = model === undefined ? undefined : this.repository.findProviderById(model.providerId);
    if (model === undefined || provider === undefined || model.kind !== 'video') {
      throw new ProviderError('invalid_request', '所选视频模型已不存在，请重新选择。');
    }
    const adapter = this.registry.find('video', provider.code);
    const descriptor = this.registry.findProvider(provider.code);
    if (adapter === undefined || descriptor === undefined) {
      throw new ProviderError('invalid_request', `服务商“${provider.displayName}”的视频适配器不可用。`);
    }
    if (!provider.isEnabled || !model.isEnabled) {
      throw new ProviderError('invalid_request', `模型“${model.displayName}”或服务商“${provider.displayName}”已被停用，请到“设置 > 模型”启用。`);
    }
    const apiKey = await this.secrets.get(providerApiKeySecretKey(provider.code));
    if (apiKey === undefined || apiKey === '') {
      throw new ProviderError('auth', `尚未配置“${provider.displayName}”的访问密钥，请到“设置 > 模型”填写。`);
    }
    return {
      adapter,
      context: { apiKey, settings: resolveProviderSettings(descriptor.settingFields, provider.settings) },
      modelCode: model.code
    };
  }

  /** 取得服务商记录及其声明；服务商不存在或没有适配器时抛出 NotFoundError。 */
  private requireProvider(providerId: number): { provider: ProviderRecord; descriptor: ProviderDescriptor } {
    const provider = this.repository.findProviderById(providerId);
    const descriptor = provider === undefined ? undefined : this.registry.findProvider(provider.code);
    if (provider === undefined || descriptor === undefined) {
      throw new NotFoundError(`服务商 ${providerId} 不存在。`);
    }
    return { provider, descriptor };
  }

  private async hasApiKey(providerCode: string): Promise<boolean> {
    const key = await this.secrets.get(providerApiKeySecretKey(providerCode));
    return key !== undefined && key !== '';
  }

  private async buildView(provider: ProviderRecord, descriptor: ProviderDescriptor): Promise<ProviderView> {
    const settings = resolveProviderSettings(descriptor.settingFields, provider.settings);
    return {
      id: provider.id,
      code: provider.code,
      displayName: provider.displayName,
      isEnabled: provider.isEnabled,
      apiKeyConfigured: await this.hasApiKey(provider.code),
      settings: descriptor.settingFields.map((field) => ({ ...field, value: settings[field.key] })),
      models: this.repository.listModels({ providerId: provider.id }).map(toModelView)
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function toModelView(model: ModelRecord): ModelView {
  return {
    id: model.id,
    code: model.code,
    displayName: model.displayName,
    kind: model.kind,
    kindLabel: MODEL_KIND_LABELS[model.kind],
    isEnabled: model.isEnabled,
    capabilitySummary: summarizeCapability(model.kind, model.capability)
  };
}
