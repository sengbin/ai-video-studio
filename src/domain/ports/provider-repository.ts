// ------------------------------------------------------------------------
// 名称：provider-repository.ts
// 说明：模型服务商与模型的数据访问端口：服务商、模型、能力的读取与适配器目录同步所需的写入。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：由基础设施层实现；时间戳由调用方传入。
// ------------------------------------------------------------------------

import { ModelKind } from '../models/model-capability';
import { ModelDescriptor, ModelRecord, NewProvider, ProviderPatch, ProviderRecord } from '../models/model-provider';

/** 模型查询条件，条件之间为“并且”。 */
export interface ModelFilter {
  readonly providerId?: number;
  readonly kind?: ModelKind;
}

/** 服务商与模型仓库。 */
export interface ProviderRepository {
  /** 列出全部服务商，按标识升序。 */
  listProviders(): ProviderRecord[];

  /** 按标识查找服务商；不存在返回 undefined。 */
  findProviderById(id: number): ProviderRecord | undefined;

  /** 按代码查找服务商；不存在返回 undefined。 */
  findProviderByCode(code: string): ProviderRecord | undefined;

  /** 新增服务商，默认启用。 */
  insertProvider(provider: NewProvider, timestamp: string): ProviderRecord;

  /** 修改服务商显示名称，与适配器声明保持一致。 */
  updateProviderName(id: number, displayName: string, timestamp: string): void;

  /**
   * 修改服务商的启用状态或设置。
   * @returns 修改后的服务商；不存在返回 undefined。
   */
  updateProvider(id: number, patch: ProviderPatch, timestamp: string): ProviderRecord | undefined;

  /** 列出模型，按服务商、类型、标识排序。 */
  listModels(filter?: ModelFilter): ModelRecord[];

  /** 按标识查找模型；不存在返回 undefined。 */
  findModelById(id: number): ModelRecord | undefined;

  /**
   * 新增模型或更新已有模型的名称、类型和能力；已有模型保留用户设置的启用状态，新模型默认启用。
   * @returns 写入后的模型。
   */
  upsertModel(providerId: number, descriptor: ModelDescriptor, timestamp: string): ModelRecord;

  /** 把服务商下不在 keepCodes 中的模型全部停用（适配器不再提供它们，但生成参数或任务可能仍引用，不能删除）。 */
  disableModelsExcept(providerId: number, keepCodes: readonly string[]): void;

  /**
   * 设置模型的启用状态。
   * @returns 模型存在返回 true。
   */
  setModelEnabled(id: number, isEnabled: boolean): boolean;
}
