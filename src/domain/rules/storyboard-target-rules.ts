// ------------------------------------------------------------------------
// 名称：storyboard-target-rules.ts
// 说明：分镜脚本表单中“目标视频模型”相关的规则：按模型能力检查画幅、分辨率与单组最长时长，给出选项文字，并按模型上限限制单组最长时长的默认值。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：纯函数；模型的时长上限取自能力描述，没有上限信息时不校验单组最长时长。
// ------------------------------------------------------------------------

import { VideoCapability } from '../models/model-capability';
import { maxGroupSeconds } from './generation-rules';
import { FieldErrors } from './field-readers';

/** 待检查的目标参数；画幅、分辨率为空串或 null 表示未指定。 */
export interface StoryboardTargetValues {
  readonly aspectRatio: string | null;
  readonly resolution: string | null;
  readonly groupMaxSeconds: number;
}

/** 目标模型选项的文字：服务商与模型名，已知单次最长时长时附在后面。 */
export function describeTargetModel(providerName: string, displayName: string, capability: VideoCapability): string {
  const max = maxGroupSeconds(capability.duration);
  return `${providerName} · ${displayName}${max === null ? '' : `（单次最长 ${max} 秒）`}`;
}

/** 把单组最长时长限制在模型的单次最长时长以内；没有选模型或模型没有上限信息时原样返回。 */
export function capGroupSeconds(seconds: number, capability: VideoCapability | undefined): number {
  const max = capability === undefined ? null : maxGroupSeconds(capability.duration);
  return max === null ? seconds : Math.min(seconds, max);
}

/**
 * 检查所选模型能否满足分镜脚本表单的目标参数。
 * @param capability 目标视频模型的能力。
 * @param target 画幅、分辨率与单组最长时长。
 * @returns 字段错误，键为表单字段键；全部满足时为空记录。
 */
export function checkStoryboardTarget(capability: VideoCapability, target: StoryboardTargetValues): FieldErrors {
  const errors: FieldErrors = {};
  if (target.aspectRatio !== null && target.aspectRatio !== '' && !capability.aspectRatios.includes(target.aspectRatio)) {
    errors.aspectRatio = `所选模型不支持画幅 ${target.aspectRatio}，可选：${capability.aspectRatios.join('、')}。`;
  }
  if (target.resolution !== null && target.resolution !== '' && !capability.resolutions.includes(target.resolution)) {
    errors.resolution = `所选模型不支持分辨率 ${target.resolution}，可选：${capability.resolutions.join('、')}。`;
  }
  const modelMax = maxGroupSeconds(capability.duration);
  if (modelMax !== null && target.groupMaxSeconds > modelMax) {
    errors.groupMaxSeconds = `单组最长时长不能超过所选模型的单次最长时长（${modelMax} 秒）。`;
  }
  return errors;
}
