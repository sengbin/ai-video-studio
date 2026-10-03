// ------------------------------------------------------------------------
// 名称：video-prompt-rules.ts
// 说明：视频提示词编译用到的文字规则：提示词格式版本、负向清单的默认值与整理、镜头语言与转场的写法、句子收尾、画幅比例的解析与比较。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：写法依据千问AI平台官方提示词指南：提示词 = 总体描述 + 参考素材引用 + 分镜（序号与起止时间）+ 台词 + 音效与背景音乐 + 风格情绪 + 负向清单；纯函数，不依赖具体模型。
// ------------------------------------------------------------------------

import { ShotRecord } from '../models/storyboard';

/**
 * 视频提示词的格式版本：改变提示词写法时加 1，写入任务快照，便于对比不同写法生成的视频。
 * 1：早期写法（时间段“(0:00 - 0:04)”，参考说明“图1是…的形象参考”）；2：按官方公式编译（分镜编号、镜头语言字段、无台词与无背景音乐、负向清单）。
 */
export const VIDEO_PROMPT_FORMAT_VERSION = 2;

/** 负向清单里各项之间的分隔符。 */
const NEGATIVE_ITEM_SEPARATOR = /[，,、；;\n]+/;

/** 转场的默认写法：切，不需要写进提示词。 */
const DEFAULT_TRANSITIONS: readonly string[] = ['', '切', '硬切', '硬切转场', '无'];

/** 两个画幅比例相差超过这个比例时，认为不一致。 */
const ASPECT_MISMATCH_TOLERANCE = 0.08;

/**
 * 整理负向清单：按分隔符拆成各项，去掉空项和重复项，并去掉在正向提示词里已经原样出现的项（官方建议不要重复正向已写明的内容）。
 * @param list 负向清单原文。
 * @param positive 正向提示词。
 * @returns 整理后的各项。
 */
export function normalizeNegativeItems(list: string, positive: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of list.split(NEGATIVE_ITEM_SEPARATOR)) {
    const item = raw.trim().replace(/[。.]+$/, '');
    if (item === '' || seen.has(item) || positive.includes(item)) continue;
    seen.add(item);
    items.push(item);
  }
  return items;
}

/** 句子收尾：去掉末尾空白，没有句末标点时补句号（末尾是英文字母或数字补“.”，否则补“。”）。 */
export function endSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  if (/[。！？!?.…]$/.test(trimmed)) return trimmed;
  return /[A-Za-z0-9)]$/.test(trimmed) ? `${trimmed}.` : `${trimmed}。`;
}

/** 镜头语言：景别、机位与视角、摄影机运动三个字段按顺序用逗号连接，空字段跳过；都为空返回空串。 */
export function describeCamera(shot: Pick<ShotRecord, 'shotSize' | 'cameraAngle' | 'cameraMovement'>): string {
  return [shot.shotSize, shot.cameraAngle, shot.cameraMovement]
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join('，');
}

/** 转场写在这一镜头的末尾（官方写法如“硬切转场”“叠化转场”）；默认的“切”不写，返回空串。 */
export function describeTransition(transition: string): string {
  const text = transition.trim();
  if (DEFAULT_TRANSITIONS.includes(text)) return '';
  return text.endsWith('转场') ? text : `${text}转场`;
}

/** 把“16:9”这样的画幅解析成宽高比（宽 / 高）；格式不对返回 null。 */
export function parseAspectRatio(text: string | null): number | null {
  if (text === null) return null;
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(text.trim());
  if (match === null) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

/** 图片的比例是否与画幅明显不一致；任何一方缺失或无法解析时视为一致。 */
export function aspectDiffers(imageWidth: number | null, imageHeight: number | null, aspectRatio: string | null): boolean {
  const target = parseAspectRatio(aspectRatio);
  if (target === null || imageWidth === null || imageHeight === null || imageWidth <= 0 || imageHeight <= 0) return false;
  return Math.abs(imageWidth / imageHeight / target - 1) > ASPECT_MISMATCH_TOLERANCE;
}

/** 把图片宽高写成接近的常见比例文字，如 750×1000 写为“3:4”；不是常见比例时写为“宽×高”。 */
export function describeImageRatio(width: number, height: number): string {
  const ratio = width / height;
  for (const [w, h] of [[16, 9], [9, 16], [4, 3], [3, 4], [1, 1], [21, 9], [3, 2], [2, 3]] as const) {
    if (Math.abs(ratio / (w / h) - 1) <= 0.03) return `${w}:${h}`;
  }
  return `${width}×${height}`;
}
