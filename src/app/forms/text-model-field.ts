// ------------------------------------------------------------------------
// 名称：text-model-field.ts
// 说明：生成文本的表单共用的“文本模型”下拉字段：字段定义、初始值、字段值与模型键的互转，以及按作品保存所选模型后再启动生成。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：选项第一项为“沿用默认”，其后是全部可选的文本模型，选项文字就是字段值；作品类表单（创意、剧本、分镜）选择的模型保存为作品的文本模型，资产没有所属作品，选择只对本次生成有效。
// ------------------------------------------------------------------------

import { ValidationError } from '../../domain/errors';
import { WorkTextModelState } from '../services/text-settings-service';
import { FormFieldSchema } from './form-schema';
import { FormValues } from './form-definition';

/** 文本模型字段的键。 */
export const TEXT_MODEL_FIELD_KEY = 'textModel';

/** 作品类表单追加在文本模型说明后的补充：所选模型会保存为作品的文本模型，之后的生成沿用。 */
export const TEXT_MODEL_SAVED_NOTE = '；选择后同时保存为作品的文本模型';

const TEXT_MODEL_UNAVAILABLE_MESSAGE = '所选文本模型已不可用，请重新选择。';
const TEXT_MODEL_DESCRIPTION_TAIL = '使用的模型；“沿用默认”使用“模型设置”中的默认文本模型，已关闭或停用的模型不在列表中';

/** 表单对文本模型选择的需求：读取候选与当前选择。 */
export interface TextModelStates {
  /**
   * 读取文本模型选择状态。
   * @param workId 作品标识；新建作品或不属于作品（资产）时为 null，没有单独选择。
   */
  getWorkState(workId: number | null): Promise<WorkTextModelState>;
}

/** 作品表单对文本模型选择的需求：读取候选与当前选择，保存或清除作品的选择。 */
export interface WorkTextModels extends TextModelStates {
  setWorkModel(workId: number, modelKey: string | null): void;
}

/** “沿用默认”选项的文字，带上当前默认模型的名称。 */
export function defaultTextModelOption(state: WorkTextModelState): string {
  return `沿用默认（${state.defaultLabel ?? '没有可用的文本模型'}）`;
}

/**
 * 创建文本模型下拉字段。
 * @param state 文本模型选择状态。
 * @param purpose 说明里的用途，如“生成剧本时”。
 * @param note 追加在说明后的补充，如选择的保存范围；没有时省略。
 */
export function createTextModelField(state: WorkTextModelState, purpose: string, note = ''): FormFieldSchema {
  const description = `${purpose}${TEXT_MODEL_DESCRIPTION_TAIL}${note}`;
  return {
    key: TEXT_MODEL_FIELD_KEY,
    label: '文本模型',
    description: state.unavailableHint === null ? description : `${description}。${state.unavailableHint}`,
    control: 'select',
    required: true,
    options: [defaultTextModelOption(state), ...state.choices.map((choice) => choice.label)]
  };
}

/** 文本模型字段的初始值：作品单独选择且仍可用的模型，否则是“沿用默认”。 */
export function textModelInitialValue(state: WorkTextModelState): string {
  const selected = state.choices.find((choice) => choice.key === state.selectedKey);
  return selected === undefined ? defaultTextModelOption(state) : selected.label;
}

/**
 * 把表单里的文本模型字段值转换为模型键。
 * @returns 模型键；“沿用默认”为 null。
 * @throws ValidationError 所选模型已不在候选列表中。
 */
export function readTextModelKey(state: WorkTextModelState, values: FormValues): string | null {
  const value = values[TEXT_MODEL_FIELD_KEY];
  if (value === undefined || value === '' || value === defaultTextModelOption(state)) {
    return null;
  }
  const chosen = state.choices.find((choice) => choice.label === value);
  if (chosen === undefined) {
    throw new ValidationError({ [TEXT_MODEL_FIELD_KEY]: TEXT_MODEL_UNAVAILABLE_MESSAGE });
  }
  return chosen.key;
}

/**
 * 把所选文本模型保存为作品的文本模型后启动生成；没能启动时恢复作品原来的选择。
 * @param state 表单打开时的文本模型选择状态，用于恢复。
 * @param modelKey 本次选择的模型键；null 表示沿用默认。
 * @param start 启动生成，生成使用作品保存的文本模型。
 */
export async function startWithWorkTextModel(
  models: WorkTextModels,
  workId: number,
  state: WorkTextModelState,
  modelKey: string | null,
  start: () => Promise<void>
): Promise<void> {
  models.setWorkModel(workId, modelKey);
  try {
    await start();
  } catch (error) {
    models.setWorkModel(workId, state.selectedKey);
    throw error;
  }
}
