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
  NewAssetFile,
  PromptStatus
} from '../models/asset';
import { AssetRevisionUpdate, PromptRevisionUpdate } from '../rules/asset-generation-rules';

/** 后台生成成功后要写入的提示词。 */
export interface GeneratedPrompts {
  readonly promptZh: string;
  readonly promptEn: string;
}

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
  /** 读取资产的缩略图（含内容），按顺序排列。 */
  listThumbnailFiles(assetId: number): AssetFileRecord[];
  /** 资产的参考文件数（不读取内容）。 */
  countReferenceFiles(assetId: number): number;
  /** 新增资产及其文件，返回资产标识；已有提示词时视为基于当前内容。 */
  insert(input: AssetInput, files: readonly NewAssetFile[], timestamp: string): number;
  /** 修改资产内容，用 files 整体替换原有文件，并写入修订信息；资产不存在时返回 false。 */
  update(id: number, content: AssetContent, files: readonly NewAssetFile[], timestamp: string, revision: AssetRevisionUpdate): boolean;
  /** 手动保存提示词并写入修订信息；资产不存在或提示词正在生成时返回 false。 */
  updatePrompts(id: number, prompts: GeneratedPrompts, revision: PromptRevisionUpdate, timestamp: string): boolean;
  /** 删除资产（连同文件和绑定）；资产不存在时返回 false。 */
  remove(id: number): boolean;
  /** 统计资产被集内实体绑定和镜头声音使用的情况。 */
  getUsage(id: number): AssetUsageSummary;
  /** 把提示词状态置为生成中；已在生成中或资产不存在时返回 false。 */
  beginPrompt(id: number, timestamp: string): boolean;
  /** 后台生成成功：写入提示词，提示词修订号加 1，依据的表单修订号取生成开始时的值。仅在生成中时生效。 */
  finishPrompt(id: number, prompts: GeneratedPrompts, basedOnContentRevision: number, timestamp: string): boolean;
  /** 后台生成失败或被取消。仅在生成中时生效。 */
  endPrompt(id: number, status: Extract<PromptStatus, 'failed' | 'canceled'>, error: string | null, timestamp: string): boolean;
  /** 列出提示词状态为生成中的资产标识。 */
  listPromptRunning(): number[];
}
