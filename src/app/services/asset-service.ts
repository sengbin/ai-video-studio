// ------------------------------------------------------------------------
// 名称：asset-service.ts
// 说明：资产应用服务：校验提交内容、检查名称唯一、调用仓库保存资产与文件、切换资产使用的文件来源（上传、生成），并在变化后通知订阅者。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code 和具体存储；资产不属于项目，全部项目共用，名称在同类型内全局唯一；创建后不能修改类型。
// ------------------------------------------------------------------------

import { ConflictError, FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { AssetFileRecord, AssetFileSource, AssetKind, AssetListItem, AssetRecord, AssetUsageSummary } from '../../domain/models/asset';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { mergeUploadContent, normalizeAssetContent, normalizeAssetPrompts } from '../../domain/rules/asset-rules';
import { computePromptRevision, computeRevisionUpdate } from '../../domain/rules/asset-generation-rules';
import { FieldErrors } from '../../domain/rules/field-readers';
import { ChangeNotifier } from './change-notifier';

/** 同类型下资产重名时的提示。 */
export const DUPLICATE_ASSET_NAME_MESSAGE = '已有同名资产，请换一个名称。';

const AUDIO_KIND_LOCKED_MESSAGE = '该音频已被绑定或引用，不能修改音频类型。';
const PROMPT_RUNNING_MESSAGE = '提示词生成中，完成后再修改提示词。';

/** 没有上传过文件却要改用上传的提示。 */
const NO_UPLOAD_FILES_MESSAGE = '还没有上传的文件，请先上传。';

/** 音频被用作音色参考时，不能改用没有文件的来源。 */
function voiceSourceEmptyMessage(count: number): string {
  return `该音频已被 ${count} 个角色用作音色参考，改用的来源还没有音频文件，请先解除绑定或准备好文件。`;
}

/** 创建资产时的可选项：由哪个脚本实体创建、所属分类（缺省为不分类）、文件来源（缺省为生成）。 */
export interface CreateAssetOptions {
  readonly sourceEntityId?: number;
  readonly categoryId?: number | null;
  /** 表单对应的文件来源：上传时必须带文件，生成时没有文件。 */
  readonly fileSource?: AssetFileSource;
}

/** 修改资产时的可选项：所属分类，null 为不分类，不传表示保持不变；表单对应的文件来源，保存后资产改用它，不传表示保持资产当前的来源。 */
export interface UpdateAssetOptions {
  readonly categoryId?: number | null;
  readonly fileSource?: AssetFileSource;
}

/** 删除资产前需要告知用户的信息。 */
export interface AssetDeletionImpact {
  readonly name: string;
  readonly usage: AssetUsageSummary;
}

/** 资产应用服务。 */
export class AssetService {
  private readonly changeNotifier = new ChangeNotifier();

  /**
   * @param repository 资产仓库。
   * @param now 返回当前时间的函数，测试时可注入固定时间。
   */
  constructor(
    private readonly repository: AssetRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** 订阅资产数据变化；返回取消订阅的函数。 */
  onDidChangeAssets(listener: () => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }

  /** 通知订阅者资产数据已变化；提示词、生成版本的后台任务在状态变化后调用。 */
  notifyChanged(): void {
    this.changeNotifier.notify();
  }

  /** 列出某类型的全部资产，按更新时间倒序。 */
  listAssets(kind: AssetKind): AssetListItem[] {
    return this.repository.list(kind);
  }

  /**
   * 读取资产。
   * @throws NotFoundError 资产不存在。
   */
  getAsset(id: number): AssetRecord {
    const asset = this.repository.findById(id);
    if (asset === undefined) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    return asset;
  }

  /** 读取资产当前使用来源的图片或音频文件（含内容）。 */
  getReferenceFiles(id: number): AssetFileRecord[] {
    return this.repository.listReferenceFiles(this.getAsset(id).id);
  }

  /** 读取资产上传的图片或音频文件（含内容），用于编辑表单带出已有文件；与当前使用的来源无关。 */
  getUploadFiles(id: number): AssetFileRecord[] {
    return this.repository.listUploadFiles(this.getAsset(id).id);
  }

  /**
   * 判断名称在同类型内是否可用，用于表单在字段失去焦点时检查重名。
   * @param excludeAssetId 修改资产时排除自身。
   */
  isNameAvailable(kind: AssetKind, name: string, excludeAssetId?: number): boolean {
    const existing = this.repository.findByName(kind, name.trim());
    return existing === undefined || existing.id === excludeAssetId;
  }

  /**
   * 创建资产。
   * @param kind 资产类型。
   * @param rawInput 表单提交的原始内容。
   * @throws ValidationError 内容不合法（上传来源没有文件也算）。
   * @throws ConflictError 同类型下名称重复。
   */
  createAsset(kind: AssetKind, rawInput: unknown, options: CreateAssetOptions = {}): AssetRecord {
    const fileSource = options.fileSource ?? 'generated';
    const errors: FieldErrors = {};
    const normalized = this.tryNormalize(rawInput, kind, fileSource, errors);
    if (Object.keys(errors).length > 0 || normalized === undefined) {
      throw new ValidationError(errors);
    }
    this.assertNameAvailable(kind, normalized.content.name);
    const id = this.repository.insert(
      { ...normalized.content, kind, sourceEntityId: options.sourceEntityId ?? null, categoryId: options.categoryId ?? null, fileSource },
      normalized.files ?? [],
      this.timestamp()
    );
    this.changeNotifier.notify();
    return this.getAsset(id);
  }

  /**
   * 修改资产的内容；类型不能修改。上传来源的表单整体替换上传的文件，生成来源的表单不触碰任何文件。改分类不影响提示词与生成状态的修订号。
   * @param options 所属分类（不传 categoryId 时保持原分类）；表单对应的文件来源（不传时保持资产当前的来源，传了且不同则保存后改用该来源）。
   * @throws ValidationError 内容不合法，已被使用的音频修改了音频类型，或被用作音色参考的音频改用了没有文件的来源。
   * @throws ConflictError 名称与同类型的其他资产重复。
   * @throws NotFoundError 资产不存在。
   */
  updateAsset(id: number, rawInput: unknown, options: UpdateAssetOptions = {}): AssetRecord {
    const asset = this.getAsset(id);
    const fileSource = options.fileSource ?? asset.fileSource;
    const errors: FieldErrors = {};
    const normalized = this.tryNormalize(rawInput, asset.kind, fileSource, errors);
    if (Object.keys(errors).length > 0 || normalized === undefined) {
      throw new ValidationError(errors);
    }
    this.assertNameAvailable(asset.kind, normalized.content.name, id);
    if (asset.kind === 'audio' && normalized.content.attributes.audio_kind !== asset.attributes.audio_kind && this.isInUse(id)) {
      throw new ValidationError({ audioKind: AUDIO_KIND_LOCKED_MESSAGE });
    }
    if (fileSource !== asset.fileSource) {
      this.assertCanUseSource(asset, fileSource, normalized.files?.length ?? this.repository.countFiles(id, fileSource));
    }
    // 表单不包含提示词，保留已有的；上传来源的表单不含生成相关字段，沿用原值。
    const merged = fileSource === 'upload' ? mergeUploadContent(asset, normalized.content) : normalized.content;
    const content = { ...merged, promptZh: asset.promptZh, promptEn: asset.promptEn };
    const revision = computeRevisionUpdate(asset, content);
    const categoryId = options.categoryId === undefined ? asset.categoryId : options.categoryId;
    if (!this.repository.update(id, content, categoryId, normalized.files, fileSource, this.timestamp(), revision)) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
    return this.getAsset(id);
  }

  /**
   * 切换资产使用的文件来源：上传与生成两种来源的文件都保留，切换后绑定与视频生成读取的是新来源的文件。
   * @throws ValidationError 改用上传但还没有上传过文件，或被用作音色参考的音频改用了没有文件的来源。
   * @throws NotFoundError 资产不存在。
   */
  switchFileSource(id: number, source: AssetFileSource): AssetRecord {
    const asset = this.getAsset(id);
    if (asset.fileSource === source) {
      return asset;
    }
    this.assertCanUseSource(asset, source, this.repository.countFiles(id, source));
    if (!this.repository.setFileSource(id, source, this.timestamp())) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
    return this.getAsset(id);
  }

  /**
   * 手动保存中英文提示词；保存即视为已确认，不再显示“需更新”。
   * @throws ValidationError 提示词不合法，或提示词正在生成。
   * @throws NotFoundError 资产不存在。
   */
  updatePrompts(id: number, rawInput: unknown): AssetRecord {
    const asset = this.getAsset(id);
    const prompts = normalizeAssetPrompts(rawInput);
    if (asset.promptStatus === 'running') {
      throw new ValidationError({ promptZh: PROMPT_RUNNING_MESSAGE });
    }
    if (!this.repository.updatePrompts(id, prompts, computePromptRevision(asset, prompts), this.timestamp())) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
    return this.getAsset(id);
  }

  /**
   * 读取删除资产前需要告知用户的名称与使用情况。
   * @throws NotFoundError 资产不存在。
   */
  getDeletionImpact(id: number): AssetDeletionImpact {
    const asset = this.getAsset(id);
    return { name: asset.name, usage: this.repository.getUsage(id) };
  }

  /**
   * 删除资产及其文件和绑定。
   * @throws NotFoundError 资产不存在。
   */
  deleteAsset(id: number): void {
    if (!this.repository.remove(id)) {
      throw new NotFoundError(`资产 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
  }

  /** 资产是否已被绑定或被镜头声音指定。 */
  private isInUse(id: number): boolean {
    const usage = this.repository.getUsage(id);
    return usage.bindings.length > 0 || usage.soundReferences > 0;
  }

  /**
   * 确认资产可以改用某个来源：改用上传必须有上传的文件；音色参考的音频被绑定后，生成时只读取它的文件，改用没有文件的来源会让参考音频被静默丢弃。
   * @param fileCount 改用后该来源的文件数。
   */
  private assertCanUseSource(asset: AssetRecord, source: AssetFileSource, fileCount: number): void {
    if (source === 'upload' && fileCount === 0) {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: NO_UPLOAD_FILES_MESSAGE });
    }
    if (asset.kind === 'audio' && fileCount === 0) {
      const voiceCount = this.repository.getUsage(asset.id).voiceBindingCount;
      if (voiceCount > 0) {
        throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: voiceSourceEmptyMessage(voiceCount) });
      }
    }
  }

  /** 校验资产内容；内容错误累积到 errors，不抛出。 */
  private tryNormalize(
    rawInput: unknown,
    kind: AssetKind,
    fileSource: AssetFileSource,
    errors: FieldErrors
  ): ReturnType<typeof normalizeAssetContent> | undefined {
    try {
      return normalizeAssetContent(rawInput, kind, fileSource);
    } catch (error) {
      if (error instanceof ValidationError) {
        Object.assign(errors, error.fieldErrors);
        return undefined;
      }
      throw error;
    }
  }

  private assertNameAvailable(kind: AssetKind, name: string, excludeAssetId?: number): void {
    if (!this.isNameAvailable(kind, name, excludeAssetId)) {
      throw new ConflictError('name', DUPLICATE_ASSET_NAME_MESSAGE);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
