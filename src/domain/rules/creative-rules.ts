// ------------------------------------------------------------------------
// 名称：creative-rules.ts
// 说明：创意阶段的规则：生成参数校验、字数统计、大纲与章节输出的校验。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：输出校验失败抛出 GeneratedOutputError，问题说明会反馈给模型重试；字数按汉字数加英文单词数统计，不计标点和空白。
// ------------------------------------------------------------------------

import { GeneratedOutputError } from '../errors';
import { ChapterDraft, ChapterOutlineItem, CreativeParams } from '../models/creative';
import {
  FieldErrors,
  assertNoFieldErrors,
  readInteger,
  readOptionalText,
  readRecord,
  readText
} from './field-readers';

/** 每章最少字数的下限。 */
export const CHAPTER_MIN_WORDS_FLOOR = 100;
/** 每章最多字数至少比最少字数多出的字数，避免范围太窄而无法满足。 */
export const CHAPTER_WORDS_MIN_GAP = 50;
/** 每章最多字数的上限。 */
export const CHAPTER_MAX_WORDS_CEILING = 100000;
/** 章节数上限的最大值。 */
export const MAX_CHAPTERS_LIMIT = 100;

export const DEFAULT_CHAPTER_MIN_WORDS = 100;
export const DEFAULT_CHAPTER_MAX_WORDS = 2500;
export const DEFAULT_MAX_CHAPTERS = 20;

export const CREATIVE_IDEA_MAX_LENGTH = 2000;
export const CREATIVE_CHOICE_MAX_LENGTH = 50;
export const CREATIVE_PRESERVE_MAX_LENGTH = 1000;
export const CREATIVE_EXTRA_MAX_LENGTH = 2000;
export const CHAPTER_TITLE_MAX_LENGTH = 100;
export const OUTLINE_SUMMARY_MAX_LENGTH = 500;
export const SUMMARY_MAX_LENGTH = 2000;

const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

/**
 * 校验并规范化创意阶段的生成参数（F3 中影响生成的字段）。
 * @param rawInput 界面提交的原始内容，数字字段可以是数字或文本。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeCreativeParams(rawInput: unknown): CreativeParams {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const optional = (key: string, label: string, maxLength: number) =>
    readOptionalText(source, { key, label, required: false, maxLength }, errors);

  const idea = optional('idea', '创作主题或灵感', CREATIVE_IDEA_MAX_LENGTH);
  const genre = optional('genre', '题材', CREATIVE_CHOICE_MAX_LENGTH);
  const tone = optional('tone', '基调', CREATIVE_CHOICE_MAX_LENGTH);
  const chapterMinWords = readInteger(
    source,
    { key: 'chapterMinWords', label: '每章最少字数', required: true, min: CHAPTER_MIN_WORDS_FLOOR, max: CHAPTER_MAX_WORDS_CEILING },
    errors
  );
  const chapterMaxWords = readInteger(
    source,
    { key: 'chapterMaxWords', label: '每章最多字数', required: true, min: CHAPTER_MIN_WORDS_FLOOR, max: CHAPTER_MAX_WORDS_CEILING },
    errors
  );
  const maxChapters = readInteger(
    source,
    { key: 'maxChapters', label: '章节数上限', required: true, min: 1, max: MAX_CHAPTERS_LIMIT },
    errors
  );
  const preserve = optional('preserve', '必须保留的内容', CREATIVE_PRESERVE_MAX_LENGTH);
  const adjust = optional('adjust', '允许调整的内容', CREATIVE_PRESERVE_MAX_LENGTH);
  const extra = optional('extra', '补充要求', CREATIVE_EXTRA_MAX_LENGTH);

  if (
    errors.chapterMinWords === undefined &&
    errors.chapterMaxWords === undefined &&
    chapterMaxWords < chapterMinWords + CHAPTER_WORDS_MIN_GAP
  ) {
    errors.chapterMaxWords = `每章最多字数至少比最少字数多 ${CHAPTER_WORDS_MIN_GAP} 字（不小于 ${chapterMinWords + CHAPTER_WORDS_MIN_GAP}）。`;
  }
  assertNoFieldErrors(errors);
  return { idea, genre, tone, chapterMinWords, chapterMaxWords, maxChapters, preserve, adjust, extra };
}

/**
 * 统计正文字数：每个汉字算 1 字，每个连续的英文字母或数字词算 1 字，不计标点和空白。
 * @param text 正文。
 */
export function countWords(text: string): number {
  return (text.match(CJK_CHARACTER)?.length ?? 0) + (text.match(LATIN_WORD)?.length ?? 0);
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读取一章依据的原文分段序号；非小说素材（segmentCount 为 0）一律返回空数组。 */
function readSources(item: unknown, seq: number, segmentCount: number, issues: string[]): number[] {
  if (segmentCount === 0) {
    return [];
  }
  const value = isRecord(item) ? item.sources : undefined;
  const valid =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => Number.isInteger(entry) && (entry as number) >= 1 && (entry as number) <= segmentCount);
  if (!valid) {
    issues.push(`第 ${seq} 章的 sources 必须是 1 到 ${segmentCount} 之间、至少包含一个序号的数组。`);
    return [];
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

/**
 * 校验并整理模型返回的章节大纲，章节序号按顺序从 1 分配。
 * @param raw 解析后的 JSON，形如 { "chapters": [{ "title": "…", "summary": "…" }] }，也接受直接的数组。
 * @param params 创意生成参数。
 * @param segmentCount 小说原文的分段数；大于 0 时每章必须给出依据的原文分段序号 sources。
 * @throws GeneratedOutputError 格式不对或章节数超过上限。
 */
export function parseOutline(raw: unknown, params: CreativeParams, segmentCount = 0): ChapterOutlineItem[] {
  const items: unknown = Array.isArray(raw) ? raw : isRecord(raw) ? raw.chapters : undefined;
  if (!Array.isArray(items)) {
    throw new GeneratedOutputError(['大纲必须是包含 chapters 数组的 JSON，例如 {"chapters":[{"title":"…","summary":"…"}]}。']);
  }

  const issues: string[] = [];
  if (items.length === 0) {
    issues.push('大纲至少需要 1 章。');
  } else if (items.length > params.maxChapters) {
    issues.push(`大纲有 ${items.length} 章，超过上限 ${params.maxChapters} 章，请合并或精简章节。`);
  }

  const outline: ChapterOutlineItem[] = [];
  items.forEach((item, index) => {
    const seq = index + 1;
    const title = isRecord(item) && typeof item.title === 'string' ? item.title.trim() : '';
    const summary = isRecord(item) && typeof item.summary === 'string' ? item.summary.trim() : '';
    if (title.length === 0 || title.length > CHAPTER_TITLE_MAX_LENGTH) {
      issues.push(`第 ${seq} 章标题必须是 1 到 ${CHAPTER_TITLE_MAX_LENGTH} 字的文本。`);
    }
    if (summary.length === 0 || summary.length > OUTLINE_SUMMARY_MAX_LENGTH) {
      issues.push(`第 ${seq} 章梗概必须是 1 到 ${OUTLINE_SUMMARY_MAX_LENGTH} 字的文本。`);
    }
    outline.push({ seq, title, summary, sources: readSources(item, seq, segmentCount, issues) });
  });

  if (issues.length > 0) {
    throw new GeneratedOutputError(issues);
  }
  return outline;
}

/**
 * 校验并整理模型返回的一章正文：只检查格式，字数不在设定范围内也接受，由界面在生成后提示。
 * @param raw 解析后的 JSON，形如 { "title": "…", "content": "…" }。
 * @param seq 本章序号，由调用方按大纲指定。
 * @throws GeneratedOutputError 格式不对。
 */
export function parseChapter(raw: unknown, seq: number): ChapterDraft {
  if (!isRecord(raw)) {
    throw new GeneratedOutputError(['章节必须是包含 title 和 content 的 JSON 对象。']);
  }

  const issues: string[] = [];
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const content = typeof raw.content === 'string' ? raw.content.trim() : '';
  if (title.length === 0 || title.length > CHAPTER_TITLE_MAX_LENGTH) {
    issues.push(`章节标题必须是 1 到 ${CHAPTER_TITLE_MAX_LENGTH} 字的文本。`);
  }
  if (content.length === 0) {
    issues.push('章节正文不能为空。');
  }

  if (issues.length > 0) {
    throw new GeneratedOutputError(issues);
  }
  return { seq, title, content };
}

/**
 * 校验并取出模型返回的要点文字（原文分段要点或图片描述）。
 * @param raw 解析后的 JSON，形如 { "summary": "…" }。
 * @throws GeneratedOutputError 缺少 summary、为空或过长。
 */
export function parseSummary(raw: unknown): string {
  const summary = isRecord(raw) && typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (summary.length === 0) {
    throw new GeneratedOutputError(['必须输出 {"summary": "…"}，且 summary 不能为空。']);
  }
  if (summary.length > SUMMARY_MAX_LENGTH) {
    throw new GeneratedOutputError([`summary 有 ${summary.length} 字，超过上限 ${SUMMARY_MAX_LENGTH} 字，请精简。`]);
  }
  return summary;
}

/** 人工编辑保存的章节正文长度上限。 */
export const CHAPTER_CONTENT_MAX_LENGTH = 100000;

/**
 * 校验并规范化用户手动编辑保存的一章：只检查格式与长度，字数范围只在界面提示，不阻止保存。
 * @param rawInput 界面提交的原始内容 { seq, title, content }。
 * @throws ValidationError 存在不合法的字段。
 */
export function normalizeChapterEdit(rawInput: unknown): ChapterDraft {
  const source = readRecord(rawInput);
  const errors: FieldErrors = {};
  const seq = readInteger(source, { key: 'seq', label: '章节序号', required: true, min: 1, max: MAX_CHAPTERS_LIMIT }, errors);
  const title = readText(source, { key: 'title', label: '章节标题', required: true, maxLength: CHAPTER_TITLE_MAX_LENGTH }, errors);
  const content = readText(source, { key: 'content', label: '章节正文', required: true, maxLength: CHAPTER_CONTENT_MAX_LENGTH }, errors);
  assertNoFieldErrors(errors);
  return { seq, title, content };
}