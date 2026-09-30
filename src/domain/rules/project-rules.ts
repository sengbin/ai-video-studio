// ------------------------------------------------------------------------
// 名称：project-rules.ts
// 说明：项目表单（F1）的字段约束与规范化规则。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：字段约束常量同时供界面表单描述使用，保证两处一致。
// ------------------------------------------------------------------------

import { VIDEO_ASPECT_RATIO_OPTIONS, VIDEO_RESOLUTION_OPTIONS } from '../models/option-sets';
import { ProjectInput } from '../models/project';
import {
  FieldErrors,
  assertNoFieldErrors,
  readOptionalChoice,
  readOptionalText,
  readRecord,
  readText
} from './field-readers';

export const PROJECT_NAME_MAX_LENGTH = 50;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 500;
export const PROJECT_VISUAL_STYLE_MAX_LENGTH = 50;

/**
 * 校验并规范化项目表单提交的内容。
 * @param rawInput 界面提交的原始内容。
 * @returns 规范化后的项目输入。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeProjectInput(rawInput: unknown): ProjectInput {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};

  const name = readText(source, { key: 'name', label: '项目名称', required: true, maxLength: PROJECT_NAME_MAX_LENGTH }, errors);
  const description = readText(
    source,
    { key: 'description', label: '项目描述', required: false, maxLength: PROJECT_DESCRIPTION_MAX_LENGTH },
    errors
  );
  const visualStyle = readOptionalText(
    source,
    { key: 'visualStyle', label: '视觉风格', required: false, maxLength: PROJECT_VISUAL_STYLE_MAX_LENGTH },
    errors
  );
  const defaultAspectRatio = readOptionalChoice(source, 'defaultAspectRatio', '默认画幅', VIDEO_ASPECT_RATIO_OPTIONS, errors);
  const defaultResolution = readOptionalChoice(source, 'defaultResolution', '默认分辨率', VIDEO_RESOLUTION_OPTIONS, errors);

  assertNoFieldErrors(errors);
  return { name, description, visualStyle, defaultAspectRatio, defaultResolution };
}
