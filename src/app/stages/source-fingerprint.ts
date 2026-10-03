// ------------------------------------------------------------------------
// 名称：source-fingerprint.ts
// 说明：创意阶段素材指纹：记录小说分段设置、各段长度与素材内容的 SHA-256，以及比较两个指纹是否一致。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：指纹随进度保存在阶段记录中；重试时只有指纹完全一致才复用已保存的要点、图片描述、大纲与章节，否则从头开始；纯函数，只依赖 node:crypto。
// ------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { ImageInput } from '../../domain/ports/text-generation-port';
import { NovelSegment, NovelSplitMode, NovelSplitSettings } from '../../domain/rules/novel-splitter';

/** 分段方式的取值，用于校验从进度中读出的指纹。 */
const SPLIT_MODES: readonly NovelSplitMode[] = ['chapter', 'length'];

/** 素材指纹：素材内容或分段设置变化后，之前保存的进度不再适用。 */
export interface SourceFingerprint {
  /** 小说的分段设置；图片素材为 null。 */
  readonly split: NovelSplitSettings | null;
  /** 各段（小说）或各张图片（图片）的长度：小说为字符数，图片为字节数。 */
  readonly lengths: readonly number[];
  /** 素材整体内容的 SHA-256（十六进制）。 */
  readonly contentHash: string;
}

/**
 * 计算小说素材的指纹。
 * @param segments 按当前设置切分出的各段。
 * @param settings 切分时使用的分段设置。
 */
export function fingerprintNovel(segments: readonly NovelSegment[], settings: NovelSplitSettings): SourceFingerprint {
  const hash = createHash('sha256');
  for (const segment of segments) {
    // 标题与长度前缀让相邻两段之间的边界移动也能改变哈希。
    hash.update(`${segment.title ?? ''}\u0000${segment.text.length}\u0000`);
    hash.update(segment.text);
  }
  return {
    split: { mode: settings.mode, maxSegmentChars: settings.maxSegmentChars },
    lengths: segments.map((segment) => segment.text.length),
    contentHash: hash.digest('hex')
  };
}

/** 计算灵感图片素材的指纹：图片的数量、顺序、类型与内容都参与。 */
export function fingerprintImages(images: readonly ImageInput[]): SourceFingerprint {
  const hash = createHash('sha256');
  for (const image of images) {
    hash.update(`${image.mimeType}\u0000${image.data.length}\u0000`);
    hash.update(image.data);
  }
  return { split: null, lengths: images.map((image) => image.data.length), contentHash: hash.digest('hex') };
}

/**
 * 从阶段记录的进度数据中读出指纹；不存在或格式不对时返回 null（视为无法确认素材没有变化）。
 * @param value 进度数据里保存的指纹。
 */
export function parseFingerprint(value: unknown): SourceFingerprint | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { split, lengths, contentHash } = value as Record<string, unknown>;
  if (typeof contentHash !== 'string' || !Array.isArray(lengths) || !lengths.every((item) => typeof item === 'number')) {
    return null;
  }
  if (split === null) {
    return { split: null, lengths: lengths as number[], contentHash };
  }
  const { mode, maxSegmentChars } = (typeof split === 'object' ? split : {}) as Record<string, unknown>;
  if (typeof mode !== 'string' || !SPLIT_MODES.includes(mode as NovelSplitMode) || typeof maxSegmentChars !== 'number') {
    return null;
  }
  return { split: { mode: mode as NovelSplitMode, maxSegmentChars }, lengths: lengths as number[], contentHash };
}

/** 两个指纹是否完全一致：分段设置、各段长度、内容哈希都相同。任一方为 null（没有指纹）时不一致。 */
export function isSameFingerprint(left: SourceFingerprint | null, right: SourceFingerprint | null): boolean {
  if (left === null || right === null) {
    return false;
  }
  const sameSplit =
    left.split === null || right.split === null
      ? left.split === right.split
      : left.split.mode === right.split.mode && left.split.maxSegmentChars === right.split.maxSegmentChars;
  return (
    sameSplit &&
    left.contentHash === right.contentHash &&
    left.lengths.length === right.lengths.length &&
    left.lengths.every((length, index) => length === right.lengths[index])
  );
}
