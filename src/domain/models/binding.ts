// ------------------------------------------------------------------------
// 名称：binding.ts
// 说明：实体绑定的领域模型：集内“脚本实体与资产”的绑定记录、绑定所需的上下文、按名称自动匹配的建议。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 entity_bindings 表；绑定属于集，同一实体在不同集可以绑定不同资产；规则见 docs/database-design.md 4.4。
// ------------------------------------------------------------------------

import { AssetKind } from './asset';
import { EntityKind } from './screenplay';

/** 绑定用途：形象绑定、音色绑定（仅角色实体）。 */
export type BindingPurpose = 'visual' | 'voice';

/** 全部绑定用途。 */
export const BINDING_PURPOSES: readonly BindingPurpose[] = ['visual', 'voice'];

/** 一条绑定记录，带实体与资产的名称，便于界面直接展示。 */
export interface BindingRecord {
  readonly id: number;
  readonly episodeId: number;
  readonly entityId: number;
  readonly entityName: string;
  readonly assetId: number;
  readonly assetName: string;
  readonly assetKind: AssetKind;
  readonly purpose: BindingPurpose;
  /** 是否为该实体在本集、该用途下的主资产；提交时使用主资产。 */
  readonly isPrimary: boolean;
  readonly note: string;
  readonly createdAt: string;
}

/** 新建绑定的内容。 */
export interface NewBinding {
  readonly episodeId: number;
  readonly entityId: number;
  readonly assetId: number;
  readonly purpose: BindingPurpose;
  readonly note: string;
}

/** 绑定校验需要的上下文：实体的类型与名称。 */
export interface BindingContext {
  readonly entityKind: EntityKind;
  readonly entityName: string;
}

/** 用于“从实体新建资产”的实体设定：所属项目、类型、名称、概述和设定字段。 */
export interface BindingEntityDetail {
  readonly projectId: number;
  readonly kind: EntityKind;
  readonly name: string;
  readonly description: string;
  /** 设定字段，键取自 ENTITY_ATTRIBUTES，值为非空文本。 */
  readonly attributes: Readonly<Record<string, string>>;
}

/** 参与自动匹配的实体。 */
export interface BindingEntityCandidate {
  readonly entityId: number;
  readonly kind: EntityKind;
  readonly name: string;
  readonly aliases: readonly string[];
}

/** 按名称自动匹配得到的绑定建议，用户确认后才写入。 */
export interface BindingSuggestion {
  readonly entityId: number;
  readonly entityName: string;
  readonly assetId: number;
  readonly assetName: string;
}
