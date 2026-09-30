// ------------------------------------------------------------------------
// 名称：creative-output-tools.ts
// 说明：创意阶段各类输出的工具定义：模型必须通过工具返回结果，参数的 JSON Schema 约束输出结构。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-01
// 备注：字段含义与 creative-rules 的解析一致；拒绝生成用可选的 refused 字段表达，所以顶层不设 required，缺字段由解析阶段反馈重试。
// ------------------------------------------------------------------------

import { OutputTool } from '../../../domain/ports/text-generation-port';

const REFUSED_PROPERTY = {
  type: 'string',
  description: '仅在因内容审查无法生成时填写拒绝原因；正常生成时不要填写，其他字段必须填写。'
} as const;

/** 要点或图片描述：{ summary }。 */
export const SUBMIT_SUMMARY_TOOL: OutputTool = {
  name: 'submit_summary',
  description: '提交整理好的要点或画面描述。',
  inputSchema: {
    type: 'object',
    properties: { summary: { type: 'string', description: '要点或画面描述文字。' }, refused: REFUSED_PROPERTY },
    additionalProperties: false
  }
};

/** 章节正文：{ title, content }。 */
export const SUBMIT_CHAPTER_TOOL: OutputTool = {
  name: 'submit_chapter',
  description: '提交本章的标题和正文。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '章节标题。' },
      content: { type: 'string', description: '章节正文，不含章节标题和字数说明。' },
      refused: REFUSED_PROPERTY
    },
    additionalProperties: false
  }
};

/**
 * 章节大纲：{ chapters: [{ title, summary, sources? }] }。
 * @param novel 素材为小说时，每章必须带 sources（依据的原文分段序号）。
 */
export function createOutlineTool(novel: boolean): OutputTool {
  const chapterProperties: Record<string, unknown> = {
    title: { type: 'string', description: '章节标题。' },
    summary: { type: 'string', description: '本章梗概：本章发生什么、推进什么。' }
  };
  if (novel) {
    chapterProperties.sources = {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
      description: '本章依据的原文分段序号。'
    };
  }
  return {
    name: 'submit_outline',
    description: '提交章节大纲。',
    inputSchema: {
      type: 'object',
      properties: {
        chapters: {
          type: 'array',
          items: {
            type: 'object',
            properties: chapterProperties,
            required: novel ? ['title', 'summary', 'sources'] : ['title', 'summary'],
            additionalProperties: false
          },
          description: '按顺序排列的章节。'
        },
        refused: REFUSED_PROPERTY
      },
      additionalProperties: false
    }
  };
}
