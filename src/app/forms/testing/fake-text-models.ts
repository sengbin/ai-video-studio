// ------------------------------------------------------------------------
// 名称：fake-text-models.ts
// 说明：表单测试共用的假文本模型选择：固定两个候选模型，把作品的选择保存在内存里。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：仅供测试使用，随 out/**/testing 一起被打包排除。
// ------------------------------------------------------------------------

import { WorkTextModelState } from '../../services/text-settings-service';
import { WorkTextModels } from '../text-model-field';

/** 默认文本模型的选项文字。 */
export const DEFAULT_TEXT_MODEL_OPTION = '沿用默认（Copilot · 自动）';

/** 作品没有单独选择时的文本模型选择状态。 */
export const TEXT_MODEL_STATE: WorkTextModelState = {
  choices: [
    { key: 'copilot:', label: 'Copilot · 自动' },
    { key: 'model:fake/fake-text', label: '假服务商 · 假文本模型' }
  ],
  defaultLabel: 'Copilot · 自动',
  selectedKey: null,
  unavailableHint: null
};

/** 假文本模型选择及其记录。 */
export interface FakeTextModels {
  readonly textModels: WorkTextModels;
  /** 作品保存的选择：键为作品标识。 */
  readonly saved: Map<number, string | null>;
  /** 作品原选择的模型已不可用时的提示：键为作品标识。 */
  readonly unavailableHints: Map<number, string>;
}

/** 创建假文本模型选择。 */
export function createFakeTextModels(): FakeTextModels {
  const saved = new Map<number, string | null>();
  const unavailableHints = new Map<number, string>();
  const textModels: WorkTextModels = {
    getWorkState: async (workId) => ({
      ...TEXT_MODEL_STATE,
      selectedKey: workId === null ? null : (saved.get(workId) ?? null),
      unavailableHint: workId === null ? null : (unavailableHints.get(workId) ?? null)
    }),
    setWorkModel: (workId, key) => {
      saved.set(workId, key);
    }
  };
  return { textModels, saved, unavailableHints };
}
