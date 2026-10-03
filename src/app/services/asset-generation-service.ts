// ------------------------------------------------------------------------
// 名称：asset-generation-service.ts
// 说明：资产生成应用服务：读取生成对话框所需的模型与默认值，校验并提交图片、音频生成（产生新版本），重试与取消，读取版本，采用版本，删除版本，补存缩略图。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；规则见 docs/ARCHITECTURE.md 6.7；每次提交新建版本，失败或取消的版本可原地重试，同一资产同时只能有一个进行中的版本；采用才写入资产文件，绑定和视频生成只读资产文件。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { AssetFileSource, AssetGenerationSummary, AssetRecord } from '../../domain/models/asset';
import {
  AssetGenerationParams,
  AssetVersionRecord,
  AssetVersionSnapshot,
  AssetVersionStatus,
  NewAssetVersionFile
} from '../../domain/models/asset-version';
import { AudioCapability, ImageCapability, ModelKind, PromptLanguage } from '../../domain/models/model-capability';
import { UsableModel } from '../../domain/models/model-provider';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { AssetVersionRepository } from '../../domain/ports/asset-version-repository';
import {
  checkGenerationAvailability,
  countUsedEpisodes,
  GenerationAvailability,
  hasUngeneratedChanges,
  modelKindOfAsset
} from '../../domain/rules/asset-generation-rules';
import { readAudioKind } from '../../domain/rules/asset-prompt-rules';
import { ASSET_AUDIO_MAX_SECONDS, ASSET_IMAGE_MAX_BYTES, ASSET_IMAGE_MAX_FILES } from '../../domain/rules/asset-rules';
import { FieldErrors, assertNoFieldErrors, readEntityId, readRecord } from '../../domain/rules/field-readers';
import { describeJobFailure } from '../../domain/rules/generation-rules';
import { detectImageMime } from '../../domain/rules/work-rules';

/** 缩略图的大小上限，单位为字节。 */
const THUMBNAIL_MAX_BYTES = 256 * 1024;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** 提交后调度生成的能力（资产生成队列实现）。 */
export interface AssetGenerationScheduler {
  pump(): Promise<void>;
  cancel(versionId: number): Promise<{ readonly remoteCanceled: boolean }>;
}

/** 资产生成服务的依赖。 */
export interface AssetGenerationServiceDependencies {
  readonly assets: AssetRepository;
  readonly versions: AssetVersionRepository;
  readonly providers: { listUsableModels(kind: ModelKind): Promise<UsableModel[]> };
  readonly scheduler: AssetGenerationScheduler;
  /** 版本变化后通知界面刷新。 */
  readonly notify: () => void;
  readonly now?: () => Date;
}

/** 生成对话框里的一个可选模型。 */
export interface GenerationModelOption {
  readonly id: number;
  readonly label: string;
  readonly capability: ImageCapability | AudioCapability;
}

/** 生成对话框的默认值。 */
export interface GenerationDefaults {
  readonly modelId: number | null;
  readonly promptLanguage: PromptLanguage;
  readonly count: number;
  readonly aspectRatio: string;
  readonly resolution: string;
  readonly language: string;
  readonly voice: string;
  readonly useReferenceImages: boolean;
}

/** 生成对话框需要的全部信息。 */
export interface AssetGenerationCatalog {
  readonly assetId: number;
  readonly name: string;
  readonly modelKind: 'image' | 'audio';
  readonly availability: GenerationAvailability;
  readonly models: readonly GenerationModelOption[];
  readonly defaults: GenerationDefaults;
  /** 资产现有的参考图数量。 */
  readonly referenceCount: number;
  readonly hasPromptZh: boolean;
  readonly hasPromptEn: boolean;
}

/** 版本在界面中的视图。 */
export interface AssetVersionView {
  readonly id: number;
  readonly assetId: number;
  readonly version: number;
  readonly status: AssetVersionStatus;
  readonly modelName: string;
  readonly promptLanguage: PromptLanguage;
  readonly count: number;
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly language: string | null;
  readonly attempt: number;
  readonly createdAt: string;
  readonly finishedAt: string | null;
  readonly isAdopted: boolean;
  /** 该版本依据的内容或提示词在它之后被修改过。 */
  readonly isOutdated: boolean;
  readonly error: { readonly label: string; readonly hint: string; readonly code: string | null; readonly message: string } | null;
}

/** 版本文件的视图：不含原始内容，缩略图以 Base64 附带。 */
export interface AssetVersionFileView {
  readonly id: number;
  readonly sortOrder: number;
  readonly mime: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly sizeBytes: number;
  readonly isAdopted: boolean;
  readonly thumbnail: { readonly mime: string; readonly data: string } | null;
}

/** 版本列表。 */
export interface AssetVersionList {
  readonly assetId: number;
  readonly name: string;
  readonly kind: AssetRecord['kind'];
  readonly versions: readonly AssetVersionView[];
  readonly adoptedVersionId: number | null;
  /** 资产当前使用的文件来源；使用上传文件时不能生成，采用版本会改用生成。 */
  readonly fileSource: AssetFileSource;
  readonly isPromptOutdated: boolean;
  /** 提示词正在后台生成。 */
  readonly isPromptRunning: boolean;
  readonly hasUngeneratedChanges: boolean;
  readonly availability: GenerationAvailability;
}

/** 单个版本的详情。 */
export interface AssetVersionDetail {
  readonly version: AssetVersionView;
  readonly promptZh: string;
  readonly promptEn: string;
  readonly files: readonly AssetVersionFileView[];
  /** 图片版本是否还有缺少缩略图的结果，页面据此补生成。 */
  readonly missingThumbnails: readonly number[];
  /** 资产被多少集绑定使用，采用前提示。 */
  readonly usedByEpisodes: number;
}

/** 资产生成应用服务。 */
export class AssetGenerationService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: AssetGenerationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  /**
   * 读取某类型资产的可用模型（模型和服务商都已启用且已配置密钥），返回逐条判断资产是否有可用模型的函数，资产列表据此决定每一行“生成”按钮能否使用。
   * 音频资产按各自的音频类型（音色参考、背景音乐、音效）分别判断：模型不支持该资产的音频类型就不算可用。
   */
  async createUsableModelCheck(kind: AssetRecord['kind']): Promise<(asset: Pick<AssetRecord, 'kind' | 'attributes'>) => boolean> {
    const usable = await this.dependencies.providers.listUsableModels(modelKindOfAsset(kind));
    return (asset) => filterUsableForAsset(usable, asset).length > 0;
  }

  /**
   * 读取生成对话框需要的模型、默认值与能否生成。
   * @throws NotFoundError 资产不存在。
   */
  async getCatalog(assetId: number): Promise<AssetGenerationCatalog> {
    const asset = this.requireAsset(assetId);
    const modelKind = modelKindOfAsset(asset.kind) as 'image' | 'audio';
    const usable = await this.listUsable(asset);
    const versions = this.dependencies.versions.listVersions(assetId);
    const availability = checkGenerationAvailability(asset, summarize(asset, versions), usable.length > 0);
    const referenceCount = asset.kind === 'audio' ? 0 : this.dependencies.assets.countReferenceFiles(assetId);
    const last = versions[0];
    const lastModel = last === undefined ? undefined : usable.find((item) => item.model.id === last.modelId);
    const first = lastModel ?? usable[0];
    const params = last?.snapshot.params;
    return {
      assetId,
      name: asset.name,
      modelKind,
      availability,
      models: usable.map((item) => ({
        id: item.model.id,
        label: `${item.providerName} · ${item.model.displayName}`,
        capability: item.model.capability as ImageCapability | AudioCapability
      })),
      defaults: {
        modelId: first?.model.id ?? null,
        promptLanguage: last?.snapshot.promptLanguage ?? (asset.promptZh !== '' ? 'zh' : 'en'),
        count: params?.count ?? 1,
        aspectRatio: params?.aspectRatio ?? asset.referenceAspectRatio ?? '',
        resolution: params?.resolution ?? '',
        language: params?.language ?? audioLanguageOf(asset) ?? '',
        voice: params?.voice ?? '',
        useReferenceImages: params?.useReferenceImages ?? false
      },
      referenceCount,
      hasPromptZh: asset.promptZh !== '',
      hasPromptEn: asset.promptEn !== ''
    };
  }

  /**
   * 提交生成：校验后新建一个版本并入队。
   * @param rawInput `{ assetId, modelId, promptLanguage, count?, aspectRatio?, resolution?, language?, voice?, useReferenceImages? }`。
   * @throws ValidationError 不能生成或参数不合法，错误以字段键定位。
   * @throws NotFoundError 资产不存在。
   */
  async submit(rawInput: unknown): Promise<{ readonly versionId: number; readonly version: number }> {
    const source = readRecord(rawInput);
    const assetId = readEntityId({ id: source.assetId }, '资产');
    const asset = this.requireAsset(assetId);
    const usable = await this.listUsable(asset);
    const versions = this.dependencies.versions.listVersions(assetId);
    const availability = checkGenerationAvailability(asset, summarize(asset, versions), usable.length > 0);
    if (!availability.available) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: availability.reason ?? '暂时不能生成。' });
    }

    const errors: FieldErrors = {};
    const choice = usable.find((item) => item.model.id === source.modelId);
    if (choice === undefined) {
      errors.modelId = '请选择可用的模型。';
    }
    const language = source.promptLanguage;
    if (language !== 'zh' && language !== 'en') {
      errors.promptLanguage = '请选择提示词语言。';
    }
    assertNoFieldErrors(errors);
    const model = (choice as UsableModel).model;
    const promptLanguage = language as PromptLanguage;
    const capability = model.capability as ImageCapability | AudioCapability;
    if (!capability.promptLanguages.includes(promptLanguage)) {
      errors.promptLanguage = '所选模型不支持这种提示词语言。';
    }
    const promptText = promptLanguage === 'zh' ? asset.promptZh : asset.promptEn;
    if (promptText === '') {
      errors.promptLanguage = `${promptLanguage === 'zh' ? '中文' : '英文'}提示词为空，请先填写或换另一种语言。`;
    } else if (promptText.length > capability.promptMaxLength) {
      errors.promptLanguage = `提示词有 ${promptText.length} 字，超过所选模型的上限 ${capability.promptMaxLength} 字。`;
    }

    const params =
      asset.kind === 'audio'
        ? this.readAudioParams(source, asset, capability as AudioCapability, errors)
        : this.readImageParams(source, assetId, capability as ImageCapability, errors);
    assertNoFieldErrors(errors);

    const snapshot: AssetVersionSnapshot = {
      providerCode: (choice as UsableModel).providerCode,
      modelCode: model.code,
      promptLanguage,
      promptZh: asset.promptZh,
      promptEn: asset.promptEn,
      params,
      referenceCount: params.useReferenceImages
        ? Math.min(this.dependencies.assets.countReferenceFiles(assetId), (capability as ImageCapability).referenceImagesMax)
        : 0,
      warnings: []
    };
    const versionId = this.dependencies.versions.createVersion(
      { assetId, modelId: model.id, snapshot, contentRevision: asset.contentRevision, promptRevision: asset.promptRevision },
      this.timestamp()
    );
    this.dependencies.notify();
    this.pump();
    return { versionId, version: (versions[0]?.version ?? 0) + 1 };
  }

  /**
   * 取消进行中的版本。
   * @returns remoteCanceled 为 false 表示服务商没有取消接口，平台任务可能继续并计费。
   * @throws NotFoundError 版本不存在或已经结束。
   */
  async cancel(versionId: number): Promise<{ readonly remoteCanceled: boolean }> {
    const result = await this.dependencies.scheduler.cancel(versionId);
    this.dependencies.notify();
    return result;
  }

  /**
   * 重试失败或已取消的版本：版本号不变，尝试次数加 1，重新排队。
   * @throws NotFoundError 版本不存在。
   * @throws ValidationError 版本不是失败或已取消，或资产已有进行中的版本。
   */
  async retry(versionId: number): Promise<void> {
    const { versions } = this.dependencies;
    const version = this.requireVersion(versionId);
    if (version.status !== 'failed' && version.status !== 'canceled') {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '只有失败或已取消的版本可以重试。' });
    }
    const active = versions.listVersions(version.assetId).some((item) => item.status === 'queued' || item.status === 'running');
    if (active) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '正在生成，请等待完成。' });
    }
    versions.restart(versionId);
    this.dependencies.notify();
    this.pump();
  }

  /**
   * 读取资产的版本列表。
   * @throws NotFoundError 资产不存在。
   */
  async listVersions(assetId: number): Promise<AssetVersionList> {
    const asset = this.requireAsset(assetId);
    const versions = this.dependencies.versions.listVersions(assetId);
    const summary = summarize(asset, versions);
    const usable = await this.listUsable(asset);
    return {
      assetId,
      name: asset.name,
      kind: asset.kind,
      versions: versions.map((version) => toView(version, asset)),
      adoptedVersionId: asset.adoptedVersionId,
      fileSource: asset.fileSource,
      isPromptOutdated: asset.promptContentRevision < asset.contentRevision && (asset.promptZh !== '' || asset.promptEn !== ''),
      isPromptRunning: asset.promptStatus === 'running',
      hasUngeneratedChanges: hasUngeneratedChanges(asset, summary),
      availability: checkGenerationAvailability(asset, summary, usable.length > 0)
    };
  }

  /**
   * 读取单个版本的详情，含结果文件的缩略图。
   * @throws NotFoundError 版本不存在。
   */
  getVersion(versionId: number): AssetVersionDetail {
    const { versions, assets } = this.dependencies;
    const version = this.requireVersion(versionId);
    const asset = this.requireAsset(version.assetId);
    const files = versions.listFiles(versionId);
    const results = files.filter((file) => file.role === 'result');
    const thumbnails = new Map(
      versions.listFilesWithContent(versionId, 'thumbnail').map((file) => [file.sortOrder, { mime: file.mime, data: file.content.toString('base64') }])
    );
    return {
      version: toView(version, asset),
      promptZh: version.snapshot.promptZh,
      promptEn: version.snapshot.promptEn,
      files: results.map((file) => ({
        id: file.id,
        sortOrder: file.sortOrder,
        mime: file.mime,
        width: file.width,
        height: file.height,
        durationSeconds: file.durationSeconds,
        sizeBytes: file.sizeBytes,
        // 采用关系以资产的 adoptedVersionId 为准：只有当前被采用的版本里，标记过的文件才算已采用。
        isAdopted: asset.adoptedVersionId === version.id && file.isAdopted,
        thumbnail: thumbnails.get(file.sortOrder) ?? null
      })),
      missingThumbnails: asset.kind === 'audio' ? [] : results.filter((file) => !thumbnails.has(file.sortOrder)).map((file) => file.sortOrder),
      usedByEpisodes: countUsedEpisodes(assets.getUsage(asset.id))
    };
  }

  /**
   * 读取一个版本结果文件的完整内容，用于查看原图或试听。
   * @throws NotFoundError 文件不存在。
   */
  getFileData(fileId: number): { readonly mime: string; readonly fileName: string; readonly data: string } {
    const file = this.dependencies.versions.getFile(fileId);
    if (file === undefined || file.role !== 'result') {
      throw new NotFoundError('文件不存在。');
    }
    return { mime: file.mime, fileName: file.fileName, data: file.content.toString('base64') };
  }

  /**
   * 保存页面补生成的缩略图和结果图尺寸。
   * @param rawInput `{ versionId, items: [{ sortOrder, width, height, thumbnail: { mimeType, data } }] }`。
   * @throws NotFoundError 版本不存在。
   * @throws ValidationError 内容不合法。
   */
  saveThumbnails(rawInput: unknown): void {
    const source = readRecord(rawInput);
    const versionId = readEntityId({ id: source.versionId }, '版本');
    this.requireVersion(versionId);
    if (!Array.isArray(source.items) || source.items.length === 0 || source.items.length > ASSET_IMAGE_MAX_FILES) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '缩略图内容格式不正确。' });
    }
    const updates = source.items.map((item: unknown) => {
      const record = readRecord(item);
      const thumb = readRecord(record.thumbnail);
      const data = thumb.data;
      if (
        !Number.isInteger(record.sortOrder) ||
        !Number.isInteger(record.width) ||
        !Number.isInteger(record.height) ||
        typeof data !== 'string' ||
        data.length === 0 ||
        data.length > Math.ceil(THUMBNAIL_MAX_BYTES / 3) * 4 ||
        !BASE64_PATTERN.test(data)
      ) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '缩略图内容格式不正确。' });
      }
      const content = Buffer.from(data, 'base64');
      const mime = detectImageMime(content);
      if (mime === null || content.length > THUMBNAIL_MAX_BYTES) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '缩略图不是有效的图片。' });
      }
      const thumbnail: NewAssetVersionFile = {
        role: 'thumbnail',
        fileName: `thumbnail-${record.sortOrder as number}`,
        mime,
        width: null,
        height: null,
        durationSeconds: null,
        content,
        sortOrder: record.sortOrder as number
      };
      return { sortOrder: record.sortOrder as number, width: record.width as number, height: record.height as number, thumbnail };
    });
    this.dependencies.versions.saveThumbnails(versionId, updates, this.timestamp());
    this.dependencies.notify();
  }

  /**
   * 采用版本：把所选结果文件整体替换为资产生成来源的文件，并改用生成来源；上传的文件保留。
   * @param rawInput `{ versionId, fileIds? }`，fileIds 缺省为版本的全部结果文件。
   * @throws NotFoundError 版本不存在。
   * @throws ValidationError 版本未成功、所选文件不属于该版本或超出限制、缩略图尚未就绪。
   */
  adopt(rawInput: unknown): void {
    const source = readRecord(rawInput);
    const version = this.requireVersion(readEntityId({ id: source.versionId }, '版本'));
    const asset = this.requireAsset(version.assetId);
    if (version.status !== 'succeeded') {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '只有生成成功的版本可以采用。' });
    }
    const { versions } = this.dependencies;
    const files = versions.listFiles(version.id);
    const results = files.filter((file) => file.role === 'result');
    const requested = source.fileIds === undefined ? results.map((file) => file.id) : source.fileIds;
    if (!Array.isArray(requested) || requested.length === 0 || requested.some((id) => !results.some((file) => file.id === id))) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '请选择要采用的文件。' });
    }
    const chosen = (requested as number[]).map((id) => results.find((file) => file.id === id) as (typeof results)[number]);
    if (asset.kind === 'audio') {
      if (chosen.length !== 1) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '音频资产只能采用 1 个文件。' });
      }
      if (chosen[0].durationSeconds !== null && chosen[0].durationSeconds > ASSET_AUDIO_MAX_SECONDS) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `音频时长超过 ${ASSET_AUDIO_MAX_SECONDS} 秒，不能采用。` });
      }
    } else {
      if (chosen.length > ASSET_IMAGE_MAX_FILES) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `最多采用 ${ASSET_IMAGE_MAX_FILES} 张图片。` });
      }
      const oversized = chosen.find((file) => file.sizeBytes > ASSET_IMAGE_MAX_BYTES);
      if (oversized !== undefined) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: `有图片超过 ${ASSET_IMAGE_MAX_BYTES / (1024 * 1024)} MB，不能采用。` });
      }
      const ready = new Set(files.filter((file) => file.role === 'thumbnail').map((file) => file.sortOrder));
      if (chosen.some((file) => !ready.has(file.sortOrder))) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '缩略图还没有准备好，请稍后再试。' });
      }
    }
    versions.adopt(asset.id, version.id, chosen.map((file) => file.id), this.timestamp());
    this.dependencies.notify();
  }

  /**
   * 删除版本及其文件。
   * @throws NotFoundError 版本不存在。
   * @throws ValidationError 版本是当前采用的，或还在进行中。
   */
  deleteVersion(versionId: number): void {
    const version = this.requireVersion(versionId);
    const asset = this.requireAsset(version.assetId);
    if (asset.adoptedVersionId === versionId) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '这个版本正在被采用，请先采用其他版本。' });
    }
    if (version.status === 'queued' || version.status === 'running') {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '这个版本还在生成中，请先取消。' });
    }
    this.dependencies.versions.deleteVersion(versionId);
    this.dependencies.notify();
  }

  /** 读取图片生成参数：数量、画幅、分辨率与是否使用参考图。 */
  private readImageParams(source: Record<string, unknown>, assetId: number, capability: ImageCapability, errors: FieldErrors): AssetGenerationParams {
    const count = source.count === undefined ? 1 : source.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > capability.imagesPerRequestMax) {
      errors.count = `生成数量必须是 1 到 ${capability.imagesPerRequestMax} 之间的整数。`;
    }
    const aspectRatio = readOption(source.aspectRatio, capability.aspectRatios, '画幅', 'aspectRatio', errors);
    const resolution = readOption(source.resolution, capability.resolutions, '分辨率', 'resolution', errors);
    const useReferenceImages = source.useReferenceImages === true;
    if (useReferenceImages && (capability.referenceImagesMax === 0 || this.dependencies.assets.countReferenceFiles(assetId) === 0)) {
      errors.useReferenceImages = '所选模型不支持参考图，或资产还没有参考图。';
    }
    return { count: typeof count === 'number' ? count : 1, aspectRatio, resolution, seed: null, language: null, voice: null, useReferenceImages, extraParams: {} };
  }

  /** 读取音频生成参数：每次固定生成 1 个；语言与预置音色受模型能力限制。 */
  private readAudioParams(source: Record<string, unknown>, asset: AssetRecord, capability: AudioCapability, errors: FieldErrors): AssetGenerationParams {
    const audioKind = readAudioKind(asset.attributes);
    if (!capability.audioKinds.includes(audioKind)) {
      errors.modelId = '所选模型不能生成这种类型的音频。';
    }
    const language = readOption(source.language, capability.languages, '语言', 'language', errors);
    const voice = readOption(source.voice, capability.voices, '音色', 'voice', errors);
    return { count: 1, aspectRatio: null, resolution: null, seed: null, language, voice, useReferenceImages: false, extraParams: {} };
  }

  /** 列出资产类型对应的可用模型；音频资产只列支持其音频类型的模型。 */
  private async listUsable(asset: AssetRecord): Promise<UsableModel[]> {
    return filterUsableForAsset(await this.dependencies.providers.listUsableModels(modelKindOfAsset(asset.kind)), asset);
  }

  private requireAsset(id: number): AssetRecord {
    const asset = this.dependencies.assets.findById(id);
    if (asset === undefined) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    return asset;
  }

  private requireVersion(id: number): AssetVersionRecord {
    const version = this.dependencies.versions.findVersion(id);
    if (version === undefined) {
      throw new NotFoundError(`版本 ${id} 不存在。`);
    }
    return version;
  }

  /** 触发队列处理一轮；处理出错不影响提交结果。 */
  private pump(): void {
    this.dependencies.scheduler.pump().catch((error: unknown) => console.error('处理资产生成队列时出现未预期的错误：', error));
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

/** 从同类型的可用模型里筛出该资产能用的：音频资产只保留支持其音频类型的模型，其余原样返回。 */
function filterUsableForAsset(usable: readonly UsableModel[], asset: Pick<AssetRecord, 'kind' | 'attributes'>): UsableModel[] {
  if (asset.kind !== 'audio') {
    return [...usable];
  }
  const audioKind = readAudioKind(asset.attributes);
  return usable.filter((item) => (item.model.capability as AudioCapability).audioKinds.includes(audioKind));
}

/** 读取可选的下拉值：空串或未提供视为不指定；不在可选范围内时记录字段错误。 */
function readOption(value: unknown, options: readonly string[], label: string, key: string, errors: FieldErrors): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !options.includes(value)) {
    errors[key] = `${label}不在所选模型支持的范围内。`;
    return null;
  }
  return value;
}

/** 音频资产的语言设置对应的语言代码；没有或为“其他”时返回 undefined。 */
function audioLanguageOf(asset: AssetRecord): string | undefined {
  const language = asset.attributes.language;
  return language === '中文' ? 'zh' : language === '英文' ? 'en' : undefined;
}

/** 按版本列表推算生成摘要（与列表查询的含义一致）。 */
function summarize(asset: AssetRecord, versions: readonly AssetVersionRecord[]): AssetGenerationSummary {
  const latest = versions.find((version) => version.status !== 'canceled');
  const succeeded = versions.filter((version) => version.status === 'succeeded');
  const adopted = versions.find((version) => version.id === asset.adoptedVersionId);
  return {
    versionCount: versions.length,
    latest:
      latest === undefined
        ? null
        : {
            id: latest.id,
            version: latest.version,
            status: latest.status,
            contentRevision: latest.contentRevision,
            promptRevision: latest.promptRevision,
            errorMessage: latest.errorMessage
          },
    latestSucceeded: succeeded.length === 0 ? null : Math.max(...succeeded.map((version) => version.version)),
    adoptedVersion: adopted?.version ?? null
  };
}

/** 转换为界面视图。 */
function toView(version: AssetVersionRecord, asset: AssetRecord): AssetVersionView {
  const { params } = version.snapshot;
  return {
    id: version.id,
    assetId: version.assetId,
    version: version.version,
    status: version.status,
    modelName: version.modelName,
    promptLanguage: version.snapshot.promptLanguage,
    count: params.count,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    language: params.language,
    attempt: version.attempt,
    createdAt: version.createdAt,
    finishedAt: version.finishedAt,
    isAdopted: asset.adoptedVersionId === version.id,
    isOutdated: version.contentRevision < asset.contentRevision || version.promptRevision < asset.promptRevision,
    error:
      version.status === 'failed' && version.errorCategory !== null
        ? {
            ...describeJobFailure({ category: version.errorCategory, code: version.errorCode, message: version.errorMessage ?? '' }),
            code: version.errorCode,
            message: version.errorMessage ?? ''
          }
        : null
  };
}
