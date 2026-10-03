// ------------------------------------------------------------------------
// 名称：asset-service.ts
// 说明：资产应用服务：校验提交内容、检查名称唯一、调用仓库保存资产与文件，并在变化后通知订阅者。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code 和具体存储；资产不属于项目，全部项目共用，名称在同类型内全局唯一；创建后不能修改类型。
// ------------------------------------------------------------------------

import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { AssetFileRecord, AssetKind, AssetListItem, AssetRecord, AssetUsageSummary } from '../../domain/models/asset';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { ASSET_FILE_FIELD_KEY, normalizeAssetContent, normalizeAssetPrompts } from '../../domain/rules/asset-rules';
import { computePromptRevision, computeRevisionUpdate, sameReferenceFiles } from '../../domain/rules/asset-generation-rules';
import { FieldErrors } from '../../domain/rules/field-readers';
import { ChangeNotifier } from './change-notifier';

/** 同类型下资产重名时的提示。 */
export const DUPLICATE_ASSET_NAME_MESSAGE = '已有同名资产，请换一个名称。';

const AUDIO_KIND_LOCKED_MESSAGE = '该音频已被绑定或引用，不能修改音频类型。';
const PROMPT_RUNNING_MESSAGE = '提示词生成中，完成后再修改提示词。';

/** 音频被用作音色参考时不能清空文件的提示。 */
function voiceFileRequiredMessage(count: number): string {
  return `该音频已被 ${count} 个角色用作音色参考，请先解除绑定或替换文件。`;
}

/** 创建资产时的可选项：由哪个脚本实体创建、所属分类（缺省为不分类）。 */
export interface CreateAssetOptions {
  readonly sourceEntityId?: number;
  readonly categoryId?: number | null;
}

/** 修改资产时的可选项：所属分类，null 为不分类，不传表示保持不变。 */
export interface UpdateAssetOptions {
  readonly categoryId?: number | null;
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

  /** 读取资产的参考文件（含内容），用于编辑表单带出已有文件。 */
  getReferenceFiles(id: number): AssetFileRecord[] {
    return this.repository.listReferenceFiles(this.getAsset(id).id);
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
   * @throws ValidationError 内容不合法。
   * @throws ConflictError 同类型下名称重复。
   */
  createAsset(kind: AssetKind, rawInput: unknown, options: CreateAssetOptions = {}): AssetRecord {
    const errors: FieldErrors = {};
    const normalized = this.tryNormalize(rawInput, kind, errors);
    if (Object.keys(errors).length > 0 || normalized === undefined) {
      throw new ValidationError(errors);
    }
    this.assertNameAvailable(kind, normalized.content.name);
    const id = this.repository.insert(
      { ...normalized.content, kind, sourceEntityId: options.sourceEntityId ?? null, categoryId: options.categoryId ?? null },
      normalized.files,
      this.timestamp()
    );
    this.changeNotifier.notify();
    return this.getAsset(id);
  }

  /**
   * 修改资产的内容并整体替换参考文件；类型不能修改。改分类不影响提示词与生成状态的修订号。
   * @param options 所属分类；不传 categoryId 时保持原分类。
   * @throws ValidationError 内容不合法，已被使用的音频修改了音频类型，或被用作音色参考的音频清空了文件。
   * @throws ConflictError 名称与同类型的其他资产重复。
   * @throws NotFoundError 资产不存在。
   */
  updateAsset(id: number, rawInput: unknown, options: UpdateAssetOptions = {}): AssetRecord {
    const asset = this.getAsset(id);
    const errors: FieldErrors = {};
    const normalized = this.tryNormalize(rawInput, asset.kind, errors);
    if (Object.keys(errors).length > 0 || normalized === undefined) {
      throw new ValidationError(errors);
    }
    this.assertNameAvailable(asset.kind, normalized.content.name, id);
    if (asset.kind === 'audio' && normalized.content.attributes.audio_kind !== asset.attributes.audio_kind && this.isInUse(id)) {
      throw new ValidationError({ audioKind: AUDIO_KIND_LOCKED_MESSAGE });
    }
    // 音色参考的音频被绑定后，生成时只读取它的文件；清空文件会让参考音频被静默丢弃，所以必须先解除绑定或替换文件。
    if (asset.kind === 'audio' && normalized.files.length === 0 && this.repository.countReferenceFiles(id) > 0) {
      const voiceCount = this.repository.getUsage(id).voiceBindingCount;
      if (voiceCount > 0) {
        throw new ValidationError({ [ASSET_FILE_FIELD_KEY]: voiceFileRequiredMessage(voiceCount) });
      }
    }
    // 表单不包含提示词，保留已有的。
    const content = { ...normalized.content, promptZh: asset.promptZh, promptEn: asset.promptEn };
    const filesChanged = !sameReferenceFiles(this.repository.listReferenceFiles(id), normalized.files);
    const revision = computeRevisionUpdate(asset, content, filesChanged);
    const categoryId = options.categoryId === undefined ? asset.categoryId : options.categoryId;
    if (!this.repository.update(id, content, categoryId, normalized.files, this.timestamp(), revision)) {
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

  /** 校验资产内容；内容错误累积到 errors，不抛出。 */
  private tryNormalize(rawInput: unknown, kind: AssetKind, errors: FieldErrors): ReturnType<typeof normalizeAssetContent> | undefined {
    try {
      return normalizeAssetContent(rawInput, kind);
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
