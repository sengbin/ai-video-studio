// ------------------------------------------------------------------------
// 名称：asset-category-repository.ts
// 说明：资产分类数据访问的端口接口：按类型列出、读取、新增、重命名、删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：同步调用；删除分类时，归入该分类的资产自动变为未分类（外键置空），资产本身保留。
// ------------------------------------------------------------------------

import { AssetKind } from '../models/asset';
import { AssetCategoryListItem, AssetCategoryRecord } from '../models/asset-category';

/** 资产分类的数据访问接口。 */
export interface AssetCategoryRepository {
  /** 列出某类型的全部分类（含资产数量），按创建顺序。 */
  list(kind: AssetKind): AssetCategoryListItem[];
  /** 按标识读取分类；不存在返回 undefined。 */
  findById(id: number): AssetCategoryRecord | undefined;
  /** 按（类型，名称）查找；不存在返回 undefined。 */
  findByName(kind: AssetKind, name: string): AssetCategoryRecord | undefined;
  /** 归入该分类的资产数量。 */
  countAssets(id: number): number;
  /** 新增分类，返回分类标识。 */
  insert(kind: AssetKind, name: string, timestamp: string): number;
  /** 修改分类名称；分类不存在时返回 false。 */
  rename(id: number, name: string, timestamp: string): boolean;
  /** 删除分类，归入该分类的资产变为未分类；分类不存在时返回 false。 */
  remove(id: number): boolean;
}
