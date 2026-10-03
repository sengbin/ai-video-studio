// ------------------------------------------------------------------------
// 名称：text-settings-service.ts
// 说明：文本模型设置服务：整理设置页需要的视图（Copilot 开关、全局默认文本模型、可选模型、小说分段），校验后保存修改，并提供作品单独选择文本模型所需的候选与读写。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code；设置即时保存，不合法的值直接拒绝而不是悄悄回退；可选模型 = Copilot（启用且检测到可用模型时）的模型 + 已启用的服务商文本模型，被关闭或停用的模型不再出现在列表中；作品没有单独选择时使用全局默认；作品单独选择的模型不可用时通过 unavailableHint 告知当前实际使用的模型。
// ------------------------------------------------------------------------

import { ValidationError } from '../../domain/errors';
import { UsableModel } from '../../domain/models/model-provider';
import { TextGenerationSettingsStore, TextModelCatalog } from '../../domain/ports/text-generation-settings-store';
import { WorkTextModelRepository } from '../../domain/ports/work-text-model-repository';
import { NovelSplitMode } from '../../domain/rules/novel-splitter';
import {
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  normalizeTextGenerationSettingsPatch
} from '../../domain/rules/text-generation-settings';
import {
  TEXT_MODEL_KEY_MAX_LENGTH,
  copilotModelKey,
  parseTextModelKey,
  providerModelKey
} from '../../domain/rules/text-model-selection';

/** 已保存的 Copilot 模型不在可用列表中时的提示。 */
export const MODEL_MISSING_HINT = '所选模型不可用，将使用自动。';

/** 没有任何可选文本模型时的提示。 */
export const NO_TEXT_MODEL_NOTE = '没有可选的文本模型，生成文本时会失败。请启用 Copilot，或在“千问AI平台”的设置中启用一个文本模型。';

/** 默认文本模型已不可用时的提示，参数为当前实际使用的模型名称。 */
export const DEFAULT_FALLBACK_HINT = (label: string): string => `原来的默认文本模型已不可用，当前使用“${label}”。`;

/** 作品原先单独选择的文本模型已不可用时的提示，参数为当前实际使用的模型名称。 */
export const WORK_MODEL_UNAVAILABLE_HINT = (label: string): string => `原选择的文本模型已不可用，当前将使用“${label}”。`;

/** 作品原先单独选择的文本模型已不可用、且没有任何可用的文本模型时的提示。 */
export const WORK_MODEL_UNAVAILABLE_NO_FALLBACK_HINT = '原选择的文本模型已不可用，且当前没有可用的文本模型，生成文本时会失败。';

/** 选用的 Copilot 已被关闭。 */
export const COPILOT_DISABLED_MESSAGE = 'Copilot 已关闭，不能选用它的模型。';

/** 选用的服务商文本模型没有启用。 */
export const MODEL_NOT_ENABLED_MESSAGE = '所选文本模型没有启用，请从列表中选择。';

/** 一个可选的文本模型。 */
export interface TextModelChoice {
  /** 模型的键，见 text-model-selection.ts。 */
  readonly key: string;
  /** 列表中显示的名称，如“Copilot · gpt-4o”“千问AI平台 · Qwen3.8 Max（旗舰）”。 */
  readonly label: string;
}

/** 设置页展示的文本模型设置。 */
export interface TextSettingsView {
  /** 是否启用 Copilot：关闭后它的模型不再出现在选择列表中。 */
  readonly copilotEnabled: boolean;
  /** 当前生效的全局默认文本模型的键；没有任何可选模型时为空串。 */
  readonly defaultModel: string;
  /** 全部可选的文本模型。 */
  readonly choices: readonly TextModelChoice[];
  readonly splitMode: NovelSplitMode;
  readonly maxSegmentChars: number;
  /** 每段字数上限的允许范围。 */
  readonly segmentCharsRange: { readonly min: number; readonly max: number };
  /** 模型相关的提示：Copilot 不可用的原因、已保存的模型不可用；没有问题时为 null。 */
  readonly modelNote: string | null;
  /** 没有任何可选文本模型时的警告；否则为 null。 */
  readonly engineNote: string | null;
}

/** 作品表单需要的文本模型选择状态。 */
export interface WorkTextModelState {
  readonly choices: readonly TextModelChoice[];
  /** 全局默认文本模型的名称；没有可选模型时为 null。 */
  readonly defaultLabel: string | null;
  /** 作品单独选择且当前仍可用的模型键；沿用默认时为 null。 */
  readonly selectedKey: string | null;
  /** 作品原先单独选择的模型已不可用时的提示（含当前实际使用的模型）；没有这种情况时为 null。 */
  readonly unavailableHint: string | null;
}

/** 设置服务对服务商文本模型的需求。 */
export interface TextModelSource {
  /** 列出可供选择的服务商文本模型（模型与服务商都已启用）。 */
  listSelectableTextModels(): UsableModel[];
}

/** 文本模型设置服务。 */
export class TextSettingsService {
  constructor(
    private readonly store: TextGenerationSettingsStore,
    private readonly catalog: TextModelCatalog,
    private readonly models: TextModelSource,
    private readonly workModels: WorkTextModelRepository
  ) {}

  /** 读取设置页视图；Copilot 模型清单查询失败不影响设置读取。 */
  async getView(): Promise<TextSettingsView> {
    const settings = this.store.read();
    const { choices, note } = await this.buildChoices(settings.copilotEnabled, settings.defaultModel);
    const stored = choices.find((choice) => choice.key === settings.defaultModel);
    const effective = stored ?? choices[0];
    const fallbackHint = stored === undefined && effective !== undefined ? DEFAULT_FALLBACK_HINT(effective.label) : null;
    // Copilot 不可用的原因与“默认已回退”的提示可能同时成立，一并告知用户。
    const modelNote = [note, fallbackHint].filter((text): text is string => text !== null).join('');
    return {
      copilotEnabled: settings.copilotEnabled,
      defaultModel: effective?.key ?? '',
      choices,
      splitMode: settings.novelSplit.mode,
      maxSegmentChars: settings.novelSplit.maxSegmentChars,
      segmentCharsRange: { min: SEGMENT_CHARS_MIN, max: SEGMENT_CHARS_MAX },
      modelNote: modelNote === '' ? null : modelNote,
      engineNote: choices.length === 0 ? NO_TEXT_MODEL_NOTE : null
    };
  }

  /**
   * 保存设置的修改。
   * @param rawPatch 界面提交的原始内容，只包含要改的项。
   * @throws ValidationError 值不合法、没有要保存的项，或选用了不可用的模型。
   */
  async update(rawPatch: unknown): Promise<void> {
    const patch = normalizeTextGenerationSettingsPatch(rawPatch);
    if (patch.defaultModel !== undefined) {
      this.assertSelectable(patch.defaultModel, patch.copilotEnabled ?? this.store.read().copilotEnabled, 'defaultModel');
    }
    await this.store.write(patch);
  }

  /** 列出当前全部可选的文本模型。 */
  async listChoices(): Promise<readonly TextModelChoice[]> {
    const settings = this.store.read();
    return (await this.buildChoices(settings.copilotEnabled, settings.defaultModel)).choices;
  }

  /**
   * 读取作品表单需要的文本模型选择状态。
   * @param workId 作品标识；新建作品时为 null，没有单独选择。
   */
  async getWorkState(workId: number | null): Promise<WorkTextModelState> {
    const settings = this.store.read();
    const { choices } = await this.buildChoices(settings.copilotEnabled, settings.defaultModel);
    const defaultChoice = choices.find((choice) => choice.key === settings.defaultModel) ?? choices[0];
    const stored = workId === null ? null : this.workModels.find(workId);
    const selected = stored === null ? undefined : choices.find((choice) => choice.key === stored);
    const defaultLabel = defaultChoice?.label ?? null;
    const unavailableHint =
      stored === null || selected !== undefined
        ? null
        : defaultLabel === null
          ? WORK_MODEL_UNAVAILABLE_NO_FALLBACK_HINT
          : WORK_MODEL_UNAVAILABLE_HINT(defaultLabel);
    return { choices, defaultLabel, selectedKey: selected?.key ?? null, unavailableHint };
  }

  /**
   * 保存或清除作品单独选择的文本模型。
   * @param workId 作品标识。
   * @param modelKey 模型键；null 表示沿用全局默认。
   * @throws ValidationError 选用了不可用的模型。
   */
  setWorkModel(workId: number, modelKey: string | null): void {
    if (modelKey !== null) {
      this.assertSelectable(modelKey, this.store.read().copilotEnabled, 'textModel');
    }
    this.workModels.save(workId, modelKey);
  }

  /** 校验键可以选用：格式正确，且 Copilot 已启用或服务商文本模型已启用。 */
  private assertSelectable(key: string, copilotEnabled: boolean, field: string): void {
    const selection = key.length > TEXT_MODEL_KEY_MAX_LENGTH ? undefined : parseTextModelKey(key);
    if (selection === undefined) {
      throw new ValidationError({ [field]: '文本模型无效，请从列表中选择。' });
    }
    if (selection.engine === 'copilot') {
      if (!copilotEnabled) {
        throw new ValidationError({ [field]: COPILOT_DISABLED_MESSAGE });
      }
      return;
    }
    const enabled = this.models
      .listSelectableTextModels()
      .some((item) => item.providerCode === selection.providerCode && item.model.code === selection.modelCode);
    if (!enabled) {
      throw new ValidationError({ [field]: MODEL_NOT_ENABLED_MESSAGE });
    }
  }

  /**
   * 组装可选模型列表：Copilot（启用且确有可用模型时）自动与各家族，再加已启用的服务商文本模型。
   * @param copilotEnabled 是否启用 Copilot。
   * @param savedKey 已保存的默认模型键；是 Copilot 的家族但不在可用列表中时，保留为“不可用”的一项，避免选中项凭空消失。
   * @returns 列表，以及 Copilot 不可用或已保存的模型不可用的提示。
   */
  private async buildChoices(copilotEnabled: boolean, savedKey: string): Promise<{ choices: TextModelChoice[]; note: string | null }> {
    const choices: TextModelChoice[] = [];
    let note: string | null = null;
    if (copilotEnabled) {
      const listed = await this.catalog.listFamilies();
      // 没有可用的 Copilot 模型时不列出“Copilot · 自动”：选了它生成也会失败，运行时会回退到服务商文本模型。
      if (listed.families.length > 0) {
        choices.push({ key: copilotModelKey(''), label: 'Copilot · 自动' });
        for (const family of listed.families) {
          choices.push({ key: copilotModelKey(family), label: `Copilot · ${family}` });
        }
      }
      const saved = parseTextModelKey(savedKey);
      const missing = saved?.engine === 'copilot' && saved.family !== '' && listed.families.length > 0 && !listed.families.includes(saved.family);
      if (saved?.engine === 'copilot' && missing) {
        choices.push({ key: savedKey, label: `Copilot · ${saved.family}（不可用）` });
      }
      note = listed.unavailableReason ?? (missing ? MODEL_MISSING_HINT : null);
    }
    for (const item of this.models.listSelectableTextModels()) {
      choices.push({ key: providerModelKey(item.providerCode, item.model.code), label: `${item.providerName} · ${item.model.displayName}` });
    }
    return { choices, note };
  }
}
