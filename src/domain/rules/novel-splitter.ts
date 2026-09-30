// ------------------------------------------------------------------------
// 名称：novel-splitter.ts
// 说明：把长小说切分为适合逐段处理的段落：按章节标题或按字数，超长部分在段落和句子边界再切分。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：纯函数；按章节切分时识别不到至少两个章节标题会回退为按字数。
// ------------------------------------------------------------------------

/** 分段方式：按章节标题或按字数。 */
export type NovelSplitMode = 'chapter' | 'length';

/** 分段设置。 */
export interface NovelSplitSettings {
  readonly mode: NovelSplitMode;
  /** 每段字符数上限。 */
  readonly maxSegmentChars: number;
}

/** 切分出的一段原文；index 从 1 开始。 */
export interface NovelSegment {
  readonly index: number;
  /** 章节标题；按字数切分或前言部分为 null。 */
  readonly title: string | null;
  readonly text: string;
}

/** 每段字符数上限允许的最小值。 */
export const MIN_SEGMENT_CHARS = 500;

const CHAPTER_HEADING =
  /^[ \t\u3000]*(?:第[零〇一二三四五六七八九十百千万两\d]+[章回节卷集部]|chapter\s+[\dIVXLC]+|#{1,3}\s+\S)[^\n]{0,60}$/i;
const SENTENCE_END = /[。！？!?…”"]/;

interface Section {
  title: string | null;
  lines: string[];
}

/** 把文本按行切成以章节标题开头的若干节；标题之前的内容为前言。 */
function splitByHeadings(text: string): Section[] {
  const sections: Section[] = [{ title: null, lines: [] }];
  for (const line of text.split(/\r?\n/)) {
    if (CHAPTER_HEADING.test(line)) {
      sections.push({ title: line.trim(), lines: [line] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

/** 在句子边界（其次是硬切）把超长的单个段落切成不超过 maxChars 的片段。 */
function hardSplit(paragraph: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (let index = window.length - 1; index >= maxChars / 2; index -= 1) {
      if (SENTENCE_END.test(window[index])) {
        cut = index + 1;
        break;
      }
    }
    const end = cut > 0 ? cut : maxChars;
    pieces.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest.length > 0) {
    pieces.push(rest);
  }
  return pieces;
}

/**
 * 把文本按行（段落）累积切分为不超过 maxChars 的片段，超长的单行再按句子切分。
 * @param text 待切分文本。
 * @param maxChars 每段字符数上限。
 */
export function splitText(text: string, maxChars: number): string[] {
  if (maxChars < 1) {
    throw new RangeError('每段字符数上限必须大于 0。');
  }
  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim().length > 0) {
      pieces.push(current.trim());
    }
    current = '';
  };

  for (const line of text.split(/\r?\n/)) {
    for (const part of line.length > maxChars ? hardSplit(line, maxChars) : [line]) {
      if (current.length > 0 && current.length + part.length + 1 > maxChars) {
        flush();
      }
      current = current.length === 0 ? part : `${current}\n${part}`;
    }
  }
  flush();
  return pieces;
}

/**
 * 把小说切分为段。
 * @param text 小说全文。
 * @param settings 分段设置。
 * @returns 段列表，序号从 1 连续编号；全文为空白时返回空数组。
 * @throws RangeError 每段字符数上限小于 MIN_SEGMENT_CHARS。
 */
export function splitNovel(text: string, settings: NovelSplitSettings): NovelSegment[] {
  if (settings.maxSegmentChars < MIN_SEGMENT_CHARS) {
    throw new RangeError(`每段字符数上限不能小于 ${MIN_SEGMENT_CHARS}。`);
  }
  if (text.trim().length === 0) {
    return [];
  }

  const sections = settings.mode === 'chapter' ? splitByHeadings(text) : [];
  const headingCount = sections.filter((section) => section.title !== null).length;
  const blocks: { title: string | null; text: string }[] =
    headingCount >= 2
      ? sections.map((section) => ({ title: section.title, text: section.lines.join('\n') }))
      : [{ title: null, text }];

  const segments: NovelSegment[] = [];
  for (const block of blocks) {
    const parts = splitText(block.text, settings.maxSegmentChars);
    parts.forEach((part, partIndex) => {
      const title = block.title === null ? null : partIndex === 0 ? block.title : `${block.title}（续${partIndex}）`;
      segments.push({ index: segments.length + 1, title, text: part });
    });
  }
  return segments;
}
