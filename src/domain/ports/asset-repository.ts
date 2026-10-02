// ------------------------------------------------------------------------
// 名称：asset-repository.ts
// 说明：资产与资产文件数据访问的端口接口：按类型列出、读取、新增、整体替换文件的修改、删除，以及使用情况统计。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：同步调用；列表不读取参考文件的内容，只带缩略图；新增、修改在一个事务内写入资产与文件，不能在已有事务中调用。
// ------------------------------------------------------------------------

import {
  AssetContent,
  AssetFileRecord,
  AssetInput,
  AssetKind,
  AssetListItem,
  AssetRecord,
  AssetUsageSummary,
  NewAssetFile
} from '../models/asset';

/** 资产的数据访问接口。 */
export interface AssetRepository {
  /** 列出某类型全部项目的资产，按更新时间倒序。 */
  list(kind: AssetKind): AssetListItem[];
  /** 按标识读取资产；不存在返回 undefined。 */
  findById(id: number): AssetRecord | undefined;
  /** 在项目内按（类型，名称）查找；不存在返回 undefined。 */
  findByName(projectId: number, kind: AssetKind, name: string): AssetRecord | undefined;
  /** 列出项目内全部资产的标识、类型和名称，用于按名称自动匹配。 */
  listProjectAssets(projectId: number): Array<{ readonly id: number; readonly kind: AssetKind; readonly name: string }>;
  /** 读取资产的参考文件（含内容），按顺序排列；不含缩略图。 */
  listReferenceFiles(assetId: number): AssetFileRecord[];
  /** 新增资产及其文件，返回资产标识。 */
  insert(input: AssetInput, files: readonly NewAssetFile[], timestamp: string): number;
  /** 修改资产内容，并用 files 整体替换原有文件；资产不存在时返回 false。 */
  update(id: number, content: AssetContent, files: readonly NewAssetFile[], timestamp: string): boolean;
  /** 删除资产（连同文件和绑定）；资产不存在时返回 false。 */
  remove(id: number): boolean;
  /** 统计资产被集内实体绑定和镜头声音使用的情况。 */
  getUsage(id: number): AssetUsageSummary;
}
