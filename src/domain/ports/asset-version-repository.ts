// ------------------------------------------------------------------------
// 名称：asset-version-repository.ts
// 说明：资产生成版本数据访问的端口接口：新建、读取、状态流转、结果文件、缩略图补写、采用与删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：同步调用；状态流转只在合法的前置状态下生效，不满足时返回 false，调用方据此判断任务是否已被取消或结束。
// ------------------------------------------------------------------------

import {
  AssetVersionFailure,
  AssetVersionFile,
  AssetVersionFileContent,
  AssetVersionRecord,
  AssetVersionStatus,
  NewAssetVersion,
  NewAssetVersionFile
} from '../models/asset-version';

/** 页面回传的补生成信息：结果图片的像素尺寸与缩略图。 */
export interface VersionThumbnailUpdate {
  readonly sortOrder: number;
  readonly width: number;
  readonly height: number;
  readonly thumbnail: NewAssetVersionFile;
}

/** 资产版本的数据访问接口。 */
export interface AssetVersionRepository {
  /** 新建版本（状态为排队中），版本号为该资产现有最大版本号加 1；返回版本标识。 */
  createVersion(input: NewAssetVersion, timestamp: string): number;
  findVersion(id: number): AssetVersionRecord | undefined;
  /** 列出资产的全部版本，版本号倒序。 */
  listVersions(assetId: number): AssetVersionRecord[];
  /** 列出处于给定状态的全部版本，先创建的在前。 */
  listByStatus(statuses: readonly AssetVersionStatus[]): AssetVersionRecord[];
  /** 排队中 → 生成中，记录远端任务标识。 */
  markSubmitted(id: number, remoteJobId: string, timestamp: string): boolean;
  /** 排队中或生成中 → 失败。 */
  markFailed(id: number, failure: AssetVersionFailure, timestamp: string): boolean;
  /** 排队中或生成中 → 已取消。 */
  markCanceled(id: number, timestamp: string): boolean;
  /** 生成中 → 成功，同时写入结果文件。 */
  markSucceeded(id: number, files: readonly NewAssetVersionFile[], timestamp: string): boolean;
  /** 失败或已取消 → 排队中，尝试次数加 1，清除上次的失败原因与远端标识。 */
  restart(id: number): boolean;
  /** 列出版本的文件（不含内容），按用途与顺序排列。 */
  listFiles(versionId: number): AssetVersionFile[];
  /** 读取版本的文件内容；文件不存在返回 undefined。 */
  getFile(fileId: number): AssetVersionFileContent | undefined;
  /** 按顺序读取版本某种用途的全部文件（含内容）。 */
  listFilesWithContent(versionId: number, role: AssetVersionFileContent['role']): AssetVersionFileContent[];
  /** 用页面补生成的缩略图和结果图尺寸更新版本；版本不存在返回 false。 */
  saveThumbnails(versionId: number, updates: readonly VersionThumbnailUpdate[], timestamp: string): boolean;
  /** 删除版本及其文件；版本不存在返回 false。 */
  deleteVersion(id: number): boolean;
  /**
   * 采用版本：把所选结果文件（及对应缩略图）整体替换为资产生成来源的文件（引用同一个磁盘文件，不复制内容），记录采用的版本，并让资产改用生成来源；上传来源的文件不受影响。
   * @param fileIds 要采用的结果文件标识，按此顺序排列。
   */
  adopt(assetId: number, versionId: number, fileIds: readonly number[], timestamp: string): void;
}
