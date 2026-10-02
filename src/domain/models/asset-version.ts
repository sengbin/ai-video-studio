// ------------------------------------------------------------------------
// 名称：asset-version.ts
// 说明：资产生成版本的领域模型：每次提交给图像、音频模型产生一个版本，同时记录任务状态、请求快照、失败原因与结果文件。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：对应 asset_versions、asset_version_files 表，字段含义见 docs/database-design.md 4.9；快照不得出现密钥。
// ------------------------------------------------------------------------

import { ProviderFailure } from '../errors';
import { PromptLanguage } from './model-capability';

/** 版本（同时是生成任务）的状态：排队、生成中、成功、失败、已取消。 */
export type AssetVersionStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

/** 仍在进行中的状态：同一资产同时只能有一个。 */
export const ACTIVE_VERSION_STATUSES: readonly AssetVersionStatus[] = ['queued', 'running'];

/** 版本的生成参数。 */
export interface AssetGenerationParams {
  /** 图片数量；音频固定为 1。 */
  readonly count: number;
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly seed: number | null;
  /** 音频：语言（zh、en）；图片为 null。 */
  readonly language: string | null;
  /** 音频：预置音色；图片为 null。 */
  readonly voice: string | null;
  /** 是否把资产现有参考图作为参考输入（仅图片）。 */
  readonly useReferenceImages: boolean;
  readonly extraParams: Readonly<Record<string, unknown>>;
}

/** 提交时的请求快照。 */
export interface AssetVersionSnapshot {
  readonly providerCode: string;
  readonly modelCode: string;
  readonly promptLanguage: PromptLanguage;
  readonly promptZh: string;
  readonly promptEn: string;
  readonly params: AssetGenerationParams;
  /** 作为参考输入的参考图数量，没有使用时为 0。 */
  readonly referenceCount: number;
  readonly warnings: readonly string[];
}

/** 版本记录。 */
export interface AssetVersionRecord {
  readonly id: number;
  readonly assetId: number;
  readonly version: number;
  readonly modelId: number;
  /** 模型的显示名称，便于界面直接展示。 */
  readonly modelName: string;
  readonly status: AssetVersionStatus;
  readonly snapshot: AssetVersionSnapshot;
  /** 提交时资产的表单内容修订号。 */
  readonly contentRevision: number;
  /** 提交时资产的提示词修订号。 */
  readonly promptRevision: number;
  readonly remoteJobId: string | null;
  readonly errorCategory: ProviderFailure | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly attempt: number;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly finishedAt: string | null;
}

/** 新建版本需要的内容。 */
export interface NewAssetVersion {
  readonly assetId: number;
  readonly modelId: number;
  readonly snapshot: AssetVersionSnapshot;
  readonly contentRevision: number;
  readonly promptRevision: number;
}

/** 任务失败的原因。 */
export interface AssetVersionFailure {
  readonly category: ProviderFailure;
  readonly code: string | null;
  readonly message: string;
}

/** 版本文件的用途：结果图片或音频、缩略图。 */
export type AssetVersionFileRole = 'result' | 'thumbnail';

/** 要写入的版本文件。 */
export interface NewAssetVersionFile {
  readonly role: AssetVersionFileRole;
  readonly fileName: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly content: Buffer;
  readonly sortOrder: number;
}

/** 版本文件（不含内容）。 */
export interface AssetVersionFile {
  readonly id: number;
  readonly versionId: number;
  readonly role: AssetVersionFileRole;
  readonly fileName: string;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly sortOrder: number;
  readonly isAdopted: boolean;
}

/** 版本文件（含内容）。 */
export interface AssetVersionFileContent extends AssetVersionFile {
  readonly content: Buffer;
}
