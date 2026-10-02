// ------------------------------------------------------------------------
// 名称：entity-asset-prefill.ts
// 说明：从脚本实体的设定生成“新建资产”表单的预填值：名称、对应的描述字段，其余设定并入补充要求。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：实体与资产同类型；超过字段长度上限的内容截断，用户可在表单里再修改；预填值使用表单键（camelCase）。
// ------------------------------------------------------------------------

import { BindingEntityDetail } from '../models/binding';
import { ENTITY_ATTRIBUTES, EntityKind } from '../models/screenplay';
import { ASSET_ATTRIBUTE_MAX_LENGTH, ASSET_EXTRA_MAX_LENGTH, ASSET_NAME_MAX_LENGTH } from './asset-rules';

/** 实体设定字段到资产表单字段的对应；没有列出的设定字段并入补充要求。 */
const ENTITY_TO_ASSET_FIELD: Readonly<Record<EntityKind, Readonly<Record<string, string>>>> = {
  character: { appearance: 'appearance', outfit: 'clothing', voice: 'voiceDescription' },
  scene: { interior_exterior: 'placeType', layout: 'layout', time_light: 'environment' },
  prop: { appearance: 'appearance', states: 'state' },
  effect: { trigger: 'source', appearance: 'appearance', changes: 'motion', targets: 'environmentInteraction' }
};

/** 补充要求里实体概述的标签。 */
const DESCRIPTION_LABEL = '设定概述';

/**
 * 生成新建资产表单的预填值。
 * @param entity 实体设定。
 * @returns 表单键到文本；没有内容的字段不出现。
 */
export function buildAssetPrefill(entity: BindingEntityDetail): Record<string, string> {
  const values: Record<string, string> = { name: entity.name.slice(0, ASSET_NAME_MAX_LENGTH) };
  const mapping = ENTITY_TO_ASSET_FIELD[entity.kind];
  const extraLines: string[] = [];
  const description = entity.description.trim();
  if (description.length > 0) {
    extraLines.push(`${DESCRIPTION_LABEL}：${description}`);
  }
  for (const attribute of ENTITY_ATTRIBUTES[entity.kind]) {
    const text = (entity.attributes[attribute.key] ?? '').trim();
    if (text.length === 0) {
      continue;
    }
    const target = mapping[attribute.key];
    if (target === undefined) {
      extraLines.push(`${attribute.label}：${text}`);
    } else {
      values[target] = text.slice(0, ASSET_ATTRIBUTE_MAX_LENGTH);
    }
  }
  if (extraLines.length > 0) {
    values.extra = extraLines.join('\n').slice(0, ASSET_EXTRA_MAX_LENGTH);
  }
  return values;
}
