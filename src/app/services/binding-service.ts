// ------------------------------------------------------------------------
// 名称：binding-service.ts
// 说明：实体绑定应用服务：为集内的脚本实体绑定资产（形象或音色），切换主资产，解除绑定，以及按名称自动匹配出绑定建议。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code 和具体存储；形象绑定要求资产与实体同类型，音色绑定要求角色实体与“音色参考”音频；资产不属于项目，任何项目的集都可以绑定；自动匹配只给出建议，不写入。
// ------------------------------------------------------------------------

import { ConflictError, FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { ASSET_KINDS, AssetListItem, AssetRecord, AssetThumbnail } from '../../domain/models/asset';
import {
  BINDING_PURPOSES,
  BindingContext,
  BindingEntityDetail,
  BindingPurpose,
  BindingRecord,
  BindingSuggestion
} from '../../domain/models/binding';
import { ENTITY_KIND_LABELS, EntityKind } from '../../domain/models/screenplay';
import { AssetRepository } from '../../domain/ports/asset-repository';
import { BindingRepository } from '../../domain/ports/binding-repository';
import { FieldErrors, assertNoFieldErrors, readRecord, readText } from '../../domain/rules/field-readers';
import { ChangeNotifier } from './change-notifier';

/** 绑定备注的长度上限。 */
export const BINDING_NOTE_MAX_LENGTH = 200;

const NOT_FOUND_MESSAGE = '集或实体不存在，或实体不属于这一集所在的作品。';
const DUPLICATE_MESSAGE = '这个实体在本集已经绑定过该资产。';
const NO_AUDIO_FILE_MESSAGE = '这个音频资产还没有音频文件，请先上传，或生成并采用。';

/** 绑定界面里的一个可选资产。 */
export interface BindingAssetOption {
  readonly id: number;
  readonly name: string;
  readonly thumbnail: AssetThumbnail | null;
  /** 音频资产的时长（秒）；图片资产为 null。 */
  readonly durationSeconds: number | null;
}

/** 实体已有的一条绑定，带资产缩略图。 */
export interface BindingItemView {
  readonly id: number;
  readonly assetId: number;
  readonly assetName: string;
  readonly isPrimary: boolean;
  readonly thumbnail: AssetThumbnail | null;
  readonly durationSeconds: number | null;
}

/** 一个实体的绑定情况：形象绑定与音色绑定（仅角色）。 */
export interface BindingEntityView {
  readonly entityId: number;
  readonly name: string;
  readonly kind: EntityKind;
  readonly kindLabel: string;
  readonly visual: readonly BindingItemView[];
  readonly voice: readonly BindingItemView[];
}

/** 一集的绑定界面视图：实体及其绑定，以及可选的资产。 */
export interface EpisodeBindingView {
  readonly episodeId: number;
  readonly entities: readonly BindingEntityView[];
  /** 按实体类型分组的可选形象资产（同类型）。 */
  readonly visualAssets: Readonly<Record<EntityKind, readonly BindingAssetOption[]>>;
  /** 可选的音色参考音频。 */
  readonly voiceAssets: readonly BindingAssetOption[];
}

/** 实体绑定应用服务。 */
export class BindingService {
  private readonly changeNotifier = new ChangeNotifier();

  /**
   * @param bindings 绑定仓库。
   * @param assets 资产仓库，用于读取被绑定的资产。
   * @param now 返回当前时间的函数，测试时可注入固定时间。
   */
  constructor(
    private readonly bindings: BindingRepository,
    private readonly assets: AssetRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** 订阅绑定数据变化；返回取消订阅的函数。 */
  onDidChangeBindings(listener: () => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }

  /** 列出一集的全部绑定。 */
  listBindings(episodeId: number): BindingRecord[] {
    return this.bindings.listByEpisode(episodeId);
  }

  /**
   * 读取集内一个实体的设定，用于从实体预填新建资产。
   * @throws NotFoundError 集或实体不存在，或实体不属于这一集所在的作品。
   */
  getEntityDetail(episodeId: number, entityId: number): BindingEntityDetail {
    const detail = this.bindings.findEntityDetail(episodeId, entityId);
    if (detail === undefined) {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }
    return detail;
  }

  /**
   * 读取一集的绑定界面视图：启用中的实体各自的形象与音色绑定（主资产在前），以及可选的资产。
   * @throws NotFoundError 集不存在。
   */
  getEpisodeView(episodeId: number): EpisodeBindingView {
    if (!this.bindings.episodeExists(episodeId)) {
      throw new NotFoundError('集不存在。');
    }
    const allAssets = new Map<number, AssetListItem>();
    for (const kind of ASSET_KINDS) {
      for (const asset of this.assets.list(kind)) {
        allAssets.set(asset.id, asset);
      }
    }
    const toOption = (asset: AssetListItem): BindingAssetOption => ({
      id: asset.id,
      name: asset.name,
      thumbnail: asset.thumbnail,
      durationSeconds: asset.durationSeconds
    });
    const byName = (left: BindingAssetOption, right: BindingAssetOption): number => left.name.localeCompare(right.name, 'zh-CN');
    const optionsOf = (match: (asset: AssetListItem) => boolean): BindingAssetOption[] =>
      [...allAssets.values()].filter(match).map(toOption).sort(byName);

    const records = this.bindings.listByEpisode(episodeId);
    const toItem = (binding: BindingRecord): BindingItemView => {
      const asset = allAssets.get(binding.assetId);
      return {
        id: binding.id,
        assetId: binding.assetId,
        assetName: binding.assetName,
        isPrimary: binding.isPrimary,
        thumbnail: asset?.thumbnail ?? null,
        durationSeconds: asset?.durationSeconds ?? null
      };
    };
    const itemsOf = (entityId: number, purpose: BindingPurpose): BindingItemView[] =>
      records
        .filter((binding) => binding.entityId === entityId && binding.purpose === purpose)
        .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || left.id - right.id)
        .map(toItem);

    return {
      episodeId,
      entities: this.bindings.listEntityCandidates(episodeId).map((entity) => ({
        entityId: entity.entityId,
        name: entity.name,
        kind: entity.kind,
        kindLabel: ENTITY_KIND_LABELS[entity.kind],
        visual: itemsOf(entity.entityId, 'visual'),
        voice: entity.kind === 'character' ? itemsOf(entity.entityId, 'voice') : []
      })),
      visualAssets: {
        character: optionsOf((asset) => asset.kind === 'character'),
        scene: optionsOf((asset) => asset.kind === 'scene'),
        prop: optionsOf((asset) => asset.kind === 'prop'),
        effect: optionsOf((asset) => asset.kind === 'effect')
      },
      voiceAssets: optionsOf((asset) => asset.kind === 'audio' && asset.attributes.audio_kind === 'voice' && asset.fileCount > 0)
    };
  }

  /**
   * 为集内的实体绑定一个资产。该实体在本集、该用途下的第一个绑定自动成为主资产。
   * @param rawInput `{ episodeId, entityId, assetId, purpose?, note? }`，purpose 缺省为形象。
   * @throws ValidationError 标识或用途无效、资产与实体不匹配。
   * @throws NotFoundError 集、实体或资产不存在。
   * @throws ConflictError 已绑定过这个资产。
   */
  bind(rawInput: unknown): BindingRecord {
    const source = readRecord(rawInput);
    const errors: FieldErrors = {};
    const episodeId = readId(source.episodeId, 'episodeId', '集', errors);
    const entityId = readId(source.entityId, 'entityId', '实体', errors);
    const assetId = readId(source.assetId, 'assetId', '资产', errors);
    const purpose = readPurpose(source.purpose, errors);
    const note = readText(source, { key: 'note', label: '备注', required: false, maxLength: BINDING_NOTE_MAX_LENGTH }, errors);
    assertNoFieldErrors(errors);

    const context = this.bindings.findContext(episodeId, entityId);
    if (context === undefined) {
      throw new NotFoundError(NOT_FOUND_MESSAGE);
    }
    const asset = this.assets.findById(assetId);
    if (asset === undefined) {
      throw new NotFoundError(`资产 ${assetId} 不存在。`);
    }
    assertCompatible(context, asset, purpose);
    if (purpose === 'voice' && this.assets.countReferenceFiles(assetId) === 0) {
      throw new ValidationError({ assetId: NO_AUDIO_FILE_MESSAGE });
    }
    if (this.bindings.findExisting(episodeId, entityId, assetId) !== undefined) {
      throw new ConflictError('assetId', DUPLICATE_MESSAGE);
    }

    const id = this.bindings.insert({ episodeId, entityId, assetId, purpose, note }, this.now().toISOString());
    this.changeNotifier.notify();
    return this.requireBinding(id);
  }

  /**
   * 解除绑定；解除的是主资产时，同一实体同一用途下最早的绑定接任主资产。
   * @throws NotFoundError 绑定不存在。
   */
  unbind(id: number): void {
    this.requireBinding(id);
    this.bindings.remove(id);
    this.changeNotifier.notify();
  }

  /**
   * 把绑定设为主资产，原来的主资产自动取消。
   * @throws NotFoundError 绑定不存在。
   */
  setPrimary(id: number): BindingRecord {
    this.requireBinding(id);
    this.bindings.setPrimary(id);
    this.changeNotifier.notify();
    return this.requireBinding(id);
  }

  /**
   * 按名称自动匹配：实体的名称或别名与同类型资产的名称相同，且还没有绑定的，列为建议。
   * 只做形象绑定的建议，不写入，由用户确认后逐条调用 bind。
   * @throws NotFoundError 集不存在。
   */
  suggestMatches(episodeId: number): BindingSuggestion[] {
    if (!this.bindings.episodeExists(episodeId)) {
      throw new NotFoundError('集不存在。');
    }
    const bound = new Set(
      this.bindings
        .listByEpisode(episodeId)
        .filter((binding) => binding.purpose === 'visual')
        .map((binding) => `${binding.entityId}:${binding.assetId}`)
    );
    const assets = this.assets.listNames();
    const suggestions: BindingSuggestion[] = [];
    for (const entity of this.bindings.listEntityCandidates(episodeId)) {
      const names = new Set([entity.name, ...entity.aliases]);
      for (const asset of assets) {
        if (asset.kind === entity.kind && names.has(asset.name) && !bound.has(`${entity.entityId}:${asset.id}`)) {
          suggestions.push({ entityId: entity.entityId, entityName: entity.name, assetId: asset.id, assetName: asset.name });
        }
      }
    }
    return suggestions;
  }

  private requireBinding(id: number): BindingRecord {
    const binding = this.bindings.findById(id);
    if (binding === undefined) {
      throw new NotFoundError(`绑定 ${id} 不存在。`);
    }
    return binding;
  }
}

/** 读取整数标识；无效时记录字段错误。 */
function readId(value: unknown, key: string, label: string, errors: FieldErrors): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors[key] = `${label}标识无效。`;
    return 0;
  }
  return value;
}

/** 读取绑定用途：缺省为形象。 */
function readPurpose(value: unknown, errors: FieldErrors): BindingPurpose {
  if (value === undefined || value === null || value === '') {
    return 'visual';
  }
  if (typeof value !== 'string' || !BINDING_PURPOSES.includes(value as BindingPurpose)) {
    errors.purpose = '绑定用途必须是形象或音色。';
    return 'visual';
  }
  return value as BindingPurpose;
}

/** 检查资产是否能绑定到实体：形象绑定要求同类型，音色绑定要求角色与音色参考音频。 */
function assertCompatible(context: BindingContext, asset: AssetRecord, purpose: BindingPurpose): void {
  if (purpose === 'visual') {
    if (asset.kind !== context.entityKind) {
      throw new ValidationError({ assetId: '形象绑定要求资产与实体同类型。' });
    }
    return;
  }
  if (context.entityKind !== 'character') {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '只有角色实体可以绑定音色。' });
  }
  if (asset.kind !== 'audio' || asset.attributes.audio_kind !== 'voice') {
    throw new ValidationError({ assetId: '音色绑定要求选择“音色参考”类型的音频资产。' });
  }
}
