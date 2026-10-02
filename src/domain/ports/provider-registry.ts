// ------------------------------------------------------------------------
// 名称：provider-registry.ts
// 说明：适配器注册表：按（模型类型，服务商代码）登记和取得图像、音频、视频模型适配器。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯内存容器，与适配器接口同层；新增模型只需新增适配器并注册，不改动服务层和界面。
// ------------------------------------------------------------------------

import { ModelKind } from '../models/model-capability';
import { ProviderDescriptor } from '../models/model-provider';
import { AnyModelProvider, ProviderAdapterByKind } from './provider-adapters';

/** 适配器注册表。 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, AnyModelProvider>();
  private readonly descriptors = new Map<string, ProviderDescriptor>();

  /**
   * 登记一个适配器。
   * @param adapter 适配器。
   * @throws Error 同一（模型类型，服务商代码）已登记，或同一服务商的声明与已登记的不一致。
   */
  register(adapter: AnyModelProvider): this {
    const key = adapterKey(adapter.kind, adapter.provider.code);
    if (this.adapters.has(key)) {
      throw new Error(`服务商 ${adapter.provider.code} 已登记${adapter.kind}模型适配器。`);
    }
    const existing = this.descriptors.get(adapter.provider.code);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(adapter.provider)) {
      throw new Error(`服务商 ${adapter.provider.code} 的各类型适配器必须声明相同的服务商信息。`);
    }
    this.descriptors.set(adapter.provider.code, adapter.provider);
    this.adapters.set(key, adapter);
    return this;
  }

  /**
   * 取得适配器；没有登记返回 undefined。
   * @param kind 模型类型。
   * @param providerCode 服务商代码。
   */
  find<TKind extends ModelKind>(kind: TKind, providerCode: string): ProviderAdapterByKind[TKind] | undefined {
    return this.adapters.get(adapterKey(kind, providerCode)) as ProviderAdapterByKind[TKind] | undefined;
  }

  /** 全部已登记的服务商声明，按登记顺序。 */
  listProviders(): ProviderDescriptor[] {
    return [...this.descriptors.values()];
  }

  /** 按代码取得服务商声明；没有登记返回 undefined。 */
  findProvider(providerCode: string): ProviderDescriptor | undefined {
    return this.descriptors.get(providerCode);
  }

  /** 某服务商登记的全部适配器，按登记顺序。 */
  listAdapters(providerCode: string): AnyModelProvider[] {
    return [...this.adapters.values()].filter((adapter) => adapter.provider.code === providerCode);
  }
}

function adapterKey(kind: ModelKind, providerCode: string): string {
  return `${kind}:${providerCode}`;
}
