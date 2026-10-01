// ------------------------------------------------------------------------
// 名称：storyboard-output-tools.ts
// 说明：分镜脚本阶段的输出工具定义：模型必须通过工具返回整集的镜头，参数的 JSON Schema 按生成参数裁剪（首帧来源、声音类型）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：字段含义与 storyboard-rules 的解析一致；拒绝生成用可选的 refused 字段表达，所以顶层不设 required。
// ------------------------------------------------------------------------

import { ENTITY_KIND_LABELS } from '../../../domain/models/screenplay';
import { SOUND_KIND_LABELS, StoryboardParams } from '../../../domain/models/storyboard';
import { OutputTool } from '../../../domain/ports/text-generation-port';

const REFUSED_PROPERTY = {
  type: 'string',
  description: '仅在因内容审查无法生成时填写拒绝原因；正常生成时不要填写，其他字段必须填写。'
} as const;

/** 声音条目的 Schema：类型限于参数中启用的声音内容。 */
function createSoundSchema(params: StoryboardParams): Record<string, unknown> {
  return {
    type: 'array',
    description: '镜头内按出现顺序排列的声音条目；没有声音时给空数组。',
    items: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...params.audioElements],
          description: params.audioElements.map((kind) => `${kind}：${SOUND_KIND_LABELS[kind]}`).join('；')
        },
        speaker: { type: 'string', description: '说话的角色名称，仅角色对白（dialogue）填写，必须是已有的角色。' },
        text: { type: 'string', description: '对白、旁白的台词；音效、背景音乐的描述。' },
        delivery: { type: 'string', description: '说话方式或声音质感，如“低声、急促”“紧张的弦乐”。' },
        startOffsetSeconds: { type: 'number', minimum: 0, description: '相对镜头起点的开始时间（秒），不确定时不填。' },
        durationSeconds: { type: 'number', exclusiveMinimum: 0, description: '持续时长（秒），不确定时不填。' }
      },
      required: ['kind', 'text'],
      additionalProperties: false
    }
  };
}

/**
 * 分镜脚本：{ shots: [{ sceneLabel, shotSize, cameraAngle, action, cameraMovement, durationSeconds, transition, continuityNote,
 * firstFrameMode?, entities, sounds?, promptZh, promptEn }] }。
 * @param params 生成参数：连贯策略为“由 AI 判断”时才有 firstFrameMode；声音模式为无声时没有 sounds。
 */
export function createStoryboardTool(params: StoryboardParams): OutputTool {
  const shotProperties: Record<string, unknown> = {
    sceneLabel: { type: 'string', description: '所属场次，如“第01场”。' },
    shotSize: { type: 'string', description: '景别，如远景、中景、特写。' },
    cameraAngle: { type: 'string', description: '机位与视角，如平视、俯拍、过肩。' },
    action: { type: 'string', description: '画面内容与主体动作。' },
    cameraMovement: { type: 'string', description: '摄影机运动，如固定、推、拉、摇、跟拍。' },
    durationSeconds: { type: 'number', exclusiveMinimum: 0, description: '镜头时长（秒）。' },
    transition: { type: 'string', description: '与下一镜头的转场，没有特别要求时填“切”。' },
    continuityNote: { type: 'string', description: '与前后镜头保持一致的要求，如服装、光线、位置。' },
    entities: {
      type: 'array',
      description: '本镜头出场的实体，只能引用实体清单中已有的实体。',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: Object.keys(ENTITY_KIND_LABELS), description: '实体类型。' },
          name: { type: 'string', description: '实体清单中的名称。' }
        },
        required: ['kind', 'name'],
        additionalProperties: false
      }
    },
    promptZh: { type: 'string', description: '中文视频提示词：只描述画面，正向表达。' },
    promptEn: { type: 'string', description: '英文视频提示词，与中文提示词含义一致。' }
  };
  const required = ['action', 'durationSeconds', 'entities', 'promptZh', 'promptEn'];
  if (params.continuity === 'ai') {
    shotProperties.firstFrameMode = {
      type: 'string',
      enum: ['none', 'prev_tail'],
      description: 'none：不指定首帧；prev_tail：以上一镜头的尾帧作为本镜头首帧，用于画面连续的镜头。第 1 个镜头只能是 none。'
    };
    required.push('firstFrameMode');
  }
  if (params.audioMode !== 'none') {
    shotProperties.sounds = createSoundSchema(params);
    required.push('sounds');
  }
  return {
    name: 'submit_storyboard',
    description: '提交一集的分镜脚本：按顺序排列的镜头。',
    inputSchema: {
      type: 'object',
      properties: {
        shots: {
          type: 'array',
          items: { type: 'object', properties: shotProperties, required, additionalProperties: false },
          description: '按顺序排列的镜头。'
        },
        refused: REFUSED_PROPERTY
      },
      additionalProperties: false
    }
  };
}
