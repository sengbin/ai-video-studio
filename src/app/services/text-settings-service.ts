// ------------------------------------------------------------------------
// 名称：text-settings-service.ts
// 说明：文本生成设置服务：整理设置页需要的视图（当前设置、可选模型、提示），校验后保存修改，并维护“Copilot 与千问文本模型二选一”的规则。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code；设置即时保存，保存前按规则校验，不合法的值直接拒绝而不是悄悄回退；Copilot 与千问文本模型同一时间只能启用其一，且至少启用其一，规则在这里统一校验，界面的确认提示只是提醒。
// ------------------------------------------------------------------------

import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { ModelRecord, ProviderView } from '../../domain/models/model-provider';
import { TextGenerationSettingsStore, TextModelCatalog } from '../../domain/ports/text-generation-settings-store';
import { readRecord } from '../../domain/rules/field-readers';
import { NovelSplitMode } from '../../domain/rules/novel-splitter';
import { readModelEnabledInput } from '../../domain/rules/provider-rules';
import {
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  normalizeTextGenerationSettingsPatch
} from '../../domain/rules/text-generation-settings';

/** 已保存的模型不在可用列表中时的提示。 */
export const MODEL_MISSING_HINT = '所选模型不可用，将使用自动。';

/** 关闭 Copilot 时没有已启用的千问文本模型。 */
export const COPILOT_OFF_NEEDS_MODEL_MESSAGE = '关闭 Copilot 前，请先在“千问AI平台”的设置中启用一个文本生成模型。';

/** Copilot 已关闭，却没有已启用的千问文本模型（例如手动改了 VS Code 设置）。 */
export const NO_TEXT_ENGINE_NOTE = '已关闭 Copilot，但没有启用任何文本生成模型，生成文本时会失败。请启用 Copilot，或启用一个千问文本模型。';

/** 停用最后一个千问文本模型会导致没有可用的文本引擎。 */
export const LAST_TEXT_MODEL_MESSAGE = '已关闭 Copilot，至少需要保留一个启用的文本生成模型；请先启用其他文本模型，或重新启用 Copilot。';

/** 启用千问文本模型前需要先关闭 Copilot。 */
export const COPILOT_ON_CONFLICT_MESSAGE = '当前使用 Copilot 生成文本，启用千问文本模型会关闭 Copilot。';

/** 设置页展示的文本生成设置。 */
export interface TextSettingsView {
  /** 是否使用 Copilot 生成文本；为 false 时使用千问AI平台的文本模型。 */
  readonly copilotEnabled: boolean;
  readonly modelFamily: string;
  readonly splitMode: NovelSplitMode;
  readonly maxSegmentChars: number;
  /** 每段字数上限的允许范围。 */
  readonly segmentCharsRange: { readonly min: number; readonly max: number };
  /** 当前可选的 Copilot 模型家族；没有启用 Copilot 时为空。 */
  readonly families: readonly string[];
  /** Copilot 模型相关的提示：没有可用模型的原因，或已保存的模型不可用；没有问题或没有启用 Copilot 时为 null。 */
  readonly modelNote: string | null;
  /** 已启用的千问文本模型名称；启用 Copilot 时为空。 */
  readonly enabledTextModels: readonly string[];
  /** 文本引擎的提示：没有启用 Copilot 也没有启用文本模型时给出警告，否则为 null。 */
  readonly engineNote: string | null;
}

/** 设置服务对服务商与文本模型的需求。 */
export interface TextModelAdmin {
  /** 按标识查找模型；不存在返回 undefined。 */
  findModel(modelId: number): ModelRecord | undefined;
  /** 列出全部文本模型。 */
  listTextModels(): ModelRecord[];
  /** 停用全部文本模型。 */
  disableTextModels(): void;
  /** 设置模型的启用状态，返回所属服务商修改后的视图。 */
  setModelEnabled(rawInput: unknown): Promise<ProviderView>;
}

/** 文本生成设置服务。 */
export class TextSettingsService {
  constructor(
    private readonly store: TextGenerationSettingsStore,
    private readonly catalog: TextModelCatalog,
    private readonly models: TextModelAdmin
  ) {}

  /** 读取设置页视图；模型清单查询失败不影响设置读取。 */
  async getView(): Promise<TextSettingsView> {
    const settings = this.store.read();
    const enabledTextModels = this.enabledTextModels().map((model) => model.displayName);
    let families: readonly string[] = [];
    let modelNote: string | null = null;
    if (settings.copilotEnabled) {
      const listed = await this.catalog.listFamilies();
      families = listed.families;
      const modelMissing = settings.modelFamily !== '' && families.length > 0 && !families.includes(settings.modelFamily);
      modelNote = listed.unavailableReason ?? (modelMissing ? MODEL_MISSING_HINT : null);
    }
    return {
      copilotEnabled: settings.copilotEnabled,
      modelFamily: settings.modelFamily,
      splitMode: settings.novelSplit.mode,
      maxSegmentChars: settings.novelSplit.maxSegmentChars,
      segmentCharsRange: { min: SEGMENT_CHARS_MIN, max: SEGMENT_CHARS_MAX },
      families,
      modelNote,
      enabledTextModels: settings.copilotEnabled ? [] : enabledTextModels,
      engineNote: !settings.copilotEnabled && enabledTextModels.length === 0 ? NO_TEXT_ENGINE_NOTE : null
    };
  }

  /**
   * 保存设置的修改。启用 Copilot 时会同时停用全部千问文本模型；关闭 Copilot 前必须已有启用的千问文本模型。
   * @param rawPatch 界面提交的原始内容，只包含要改的项。
   * @throws ValidationError 值不合法、没有要保存的项，或关闭 Copilot 时没有启用的文本模型。
   */
  async update(rawPatch: unknown): Promise<void> {
    const patch = normalizeTextGenerationSettingsPatch(rawPatch);
    if (patch.copilotEnabled === false && this.enabledTextModels().length === 0) {
      throw new ValidationError({ copilotEnabled: COPILOT_OFF_NEEDS_MODEL_MESSAGE });
    }
    await this.store.write(patch);
    if (patch.copilotEnabled === true) {
      this.models.disableTextModels();
    }
  }

  /**
   * 设置模型的启用状态，返回所属服务商修改后的视图；千问文本模型与 Copilot 二选一，其他类型的模型直接交给服务商处理。
   * @param rawInput 界面提交的原始内容：modelId、isEnabled，以及启用文本模型时是否同意关闭 Copilot 的 closeCopilot。
   * @throws ValidationError 内容不合法，或停用最后一个文本模型会导致没有可用的文本引擎。
   * @throws ConflictError 正在使用 Copilot，且没有同意关闭它。
   * @throws NotFoundError 模型不存在。
   */
  async setModelEnabled(rawInput: unknown): Promise<ProviderView> {
    const { modelId, isEnabled } = readModelEnabledInput(rawInput);
    const model = this.models.findModel(modelId);
    if (model === undefined) {
      throw new NotFoundError(`模型 ${modelId} 不存在。`);
    }
    if (model.kind !== 'text') {
      return this.models.setModelEnabled(rawInput);
    }

    const settings = this.store.read();
    if (!isEnabled) {
      if (model.isEnabled && !settings.copilotEnabled && this.enabledTextModels().length === 1) {
        throw new ValidationError({ isEnabled: LAST_TEXT_MODEL_MESSAGE });
      }
      return this.models.setModelEnabled(rawInput);
    }
    if (!settings.copilotEnabled) {
      return this.models.setModelEnabled(rawInput);
    }
    if (readRecord(rawInput).closeCopilot !== true) {
      throw new ConflictError('isEnabled', COPILOT_ON_CONFLICT_MESSAGE);
    }
    const view = await this.models.setModelEnabled(rawInput);
    try {
      await this.store.write({ copilotEnabled: false });
    } catch (error) {
      // 没能关闭 Copilot：撤销刚才的启用，避免两个引擎同时启用。
      await this.models.setModelEnabled({ modelId, isEnabled: false });
      throw error;
    }
    return view;
  }

  private enabledTextModels(): ModelRecord[] {
    return this.models.listTextModels().filter((model) => model.isEnabled);
  }
}
