// ------------------------------------------------------------------------
// 名称：asset-category.ts
// 说明：资产分类的领域模型：分类记录与带资产数量的列表项。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：对应 asset_categories 表；分类属于某个资产类型，同类型内名称唯一；资产未分类时 categoryId 为 null。
// ------------------------------------------------------------------------

import { AssetKind } from './asset';

/** 已保存的资产分类。 */
export interface AssetCategoryRecord {
  readonly id: number;
  /** 分类所属的资产类型，创建后不能修改。 */
  readonly kind: AssetKind;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 列表中的一个分类：带归入该分类的资产数量。 */
export interface AssetCategoryListItem extends AssetCategoryRecord {
  readonly assetCount: number;
}

/** 删除分类前需要告知用户的信息：删除后这些资产变为未分类，资产本身不会被删除。 */
export interface AssetCategoryDeletionImpact {
  readonly name: string;
  readonly assetCount: number;
}
