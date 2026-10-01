// ------------------------------------------------------------------------
// 名称：screenplay-output-tools.ts
// 说明：剧本阶段各类输出的工具定义：模型必须通过工具返回剧本包与抽取结果，参数的 JSON Schema 约束输出结构。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：字段含义与 screenplay-rules 的解析一致；拒绝生成用可选的 refused 字段表达，所以顶层不设 required。
// ------------------------------------------------------------------------

import { ENTITY_ATTRIBUTES, ENTITY_KIND_LABELS, EntityKind } from '../../../domain/models/screenplay';
import { OutputTool } from '../../../domain/ports/text-generation-port';

const REFUSED_PROPERTY = {
  type: 'string',
  description: '仅在因内容审查无法生成时填写拒绝原因；正常生成时不要填写，其他字段必须填写。'
} as const;

/** 剧本包：{ title, overview, fullText }。 */
export const SUBMIT_SCREENPLAY_TOOL: OutputTool = {
  name: 'submit_screenplay',
  description: '提交剧本包：作品标题、作品信息与梗概、完整剧本正文。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '作品标题。' },
      overview: { type: 'string', description: '作品信息与改编梗概：题材、基调、故事主线、主要人物关系。' },
      fullText: { type: 'string', description: '完整剧本正文，不含标题和梗概。' },
      refused: REFUSED_PROPERTY
    },
    additionalProperties: false
  }
};

/** 设定字段的并集：各类型的键合并，说明写明适用类型。 */
function createAttributeProperties(): Record<string, unknown> {
  const properties: Record<string, { type: string; description: string }> = {};
  for (const kind of Object.keys(ENTITY_ATTRIBUTES) as EntityKind[]) {
    for (const { key, label } of ENTITY_ATTRIBUTES[kind]) {
      const scope = `${ENTITY_KIND_LABELS[kind]}：${label}`;
      const previous = properties[key];
      properties[key] = { type: 'string', description: previous === undefined ? scope : `${previous.description}；${scope}` };
    }
  }
  return properties;
}

/**
 * 抽取结果：{ episodes: [{ title, synopsis, screenplayText?, targetDurationSeconds? }], entities: [{ kind, name, aliases?, description, attributes? }] }。
 * @param single 单个短视频：只有一集，不需要标题与本集正文。
 */
export function createStructureTool(single: boolean): OutputTool {
  const episodeProperties: Record<string, unknown> = {
    synopsis: { type: 'string', description: '本集梗概。' },
    targetDurationSeconds: { type: 'integer', minimum: 1, description: '本集预计时长（秒），不得超过单集最大时长。' }
  };
  if (!single) {
    episodeProperties.title = { type: 'string', description: '集标题。' };
    episodeProperties.screenplayText = { type: 'string', description: '本集剧本正文：从剧本正文中原样摘录属于本集的部分。' };
  }
  return {
    name: 'submit_structure',
    description: '提交从剧本正文抽取的集和实体。',
    inputSchema: {
      type: 'object',
      properties: {
        episodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: episodeProperties,
            required: single ? ['synopsis'] : ['title', 'synopsis', 'screenplayText'],
            additionalProperties: false
          },
          description: '按顺序排列的集。'
        },
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: Object.keys(ENTITY_KIND_LABELS), description: '实体类型。' },
              name: { type: 'string', description: '稳定名称，同类型内不重复。' },
              aliases: { type: 'array', items: { type: 'string' }, description: '剧本中出现的别名、称呼。' },
              description: { type: 'string', description: '设定摘要。' },
              attributes: {
                type: 'object',
                properties: createAttributeProperties(),
                additionalProperties: false,
                description: '按类型区分的设定，只填写该类型适用的字段。'
              }
            },
            required: ['kind', 'name', 'description'],
            additionalProperties: false
          },
          description: '剧本中出现的角色、场景、道具和特效。'
        },
        refused: REFUSED_PROPERTY
      },
      additionalProperties: false
    }
  };
}
