// ------------------------------------------------------------------------
// 名称：text-settings-service.ts
// 说明：文本生成设置服务：整理设置页需要的视图（当前设置、可选模型、提示），并校验后保存修改。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；设置即时保存，保存前按规则校验，不合法的值直接拒绝而不是悄悄回退。
// ------------------------------------------------------------------------

import { TextGenerationSettingsStore, TextModelCatalog } from '../../domain/ports/text-generation-settings-store';
import { NovelSplitMode } from '../../domain/rules/novel-splitter';
import {
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  normalizeTextGenerationSettingsPatch
} from '../../domain/rules/text-generation-settings';

/** 已保存的模型不在可用列表中时的提示。 */
export const MODEL_MISSING_HINT = '所选模型不可用，将使用自动。';

/** 设置页展示的文本生成设置。 */
export interface TextSettingsView {
  readonly modelFamily: string;
  readonly splitMode: NovelSplitMode;
  readonly maxSegmentChars: number;
  /** 每段字数上限的允许范围。 */
  readonly segmentCharsRange: { readonly min: number; readonly max: number };
  /** 当前可选的模型家族。 */
  readonly families: readonly string[];
  /** 模型相关的提示：没有可用模型的原因，或已保存的模型不可用；没有问题时为 null。 */
  readonly modelNote: string | null;
}

/** 文本生成设置服务。 */
export class TextSettingsService {
  constructor(
    private readonly store: TextGenerationSettingsStore,
    private readonly catalog: TextModelCatalog
  ) {}

  /** 读取设置页视图；模型清单查询失败不影响设置读取。 */
  async getView(): Promise<TextSettingsView> {
    const settings = this.store.read();
    const { families, unavailableReason } = await this.catalog.listFamilies();
    const modelMissing = settings.modelFamily !== '' && families.length > 0 && !families.includes(settings.modelFamily);
    return {
      modelFamily: settings.modelFamily,
      splitMode: settings.novelSplit.mode,
      maxSegmentChars: settings.novelSplit.maxSegmentChars,
      segmentCharsRange: { min: SEGMENT_CHARS_MIN, max: SEGMENT_CHARS_MAX },
      families,
      modelNote: unavailableReason ?? (modelMissing ? MODEL_MISSING_HINT : null)
    };
  }

  /**
   * 保存设置的修改。
   * @param rawPatch 界面提交的原始内容，只包含要改的项。
   * @throws ValidationError 值不合法或没有要保存的项。
   */
  async update(rawPatch: unknown): Promise<void> {
    await this.store.write(normalizeTextGenerationSettingsPatch(rawPatch));
  }
}
