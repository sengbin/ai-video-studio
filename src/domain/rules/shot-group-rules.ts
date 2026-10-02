// ------------------------------------------------------------------------
// 名称：shot-group-rules.ts
// 说明：镜头分组的规则：按单组最长时长把相邻镜头顺序打包成组，保留已有分组并补上新增镜头，以及拆分、合并组的布局计算。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：纯函数；分组按镜头序号连续，一个组对应一次视频生成；单个镜头超过上限时独占一组，由提交校验给出提示。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../errors';
import { GroupLayoutEntry, StoryboardParams } from '../models/storyboard';

/** 单组最长时长的默认值与取值范围（秒）。 */
export const DEFAULT_GROUP_MAX_SECONDS = 15;
export const GROUP_SECONDS_MIN = 2;
export const GROUP_SECONDS_MAX = 120;

/** 在场次变化处断开时，断开前的部分至少要占上限的比例，避免为了对齐场次产生过短的组。 */
const MIN_SCENE_SPLIT_RATIO = 0.5;

/** 比较时长的误差，避免小数累加造成 15.000000001 > 15。 */
const EPSILON = 1e-6;

/** 参与分组的镜头信息。 */
export interface GroupableShot {
  readonly id: number;
  readonly sceneLabel: string;
  readonly durationSeconds: number;
}

/** 已分组或未分组的镜头。 */
export interface GroupedShot extends GroupableShot {
  /** 所在组；null 表示还没有分组。 */
  readonly groupId: number | null;
}

/** 打包计划中的一组。 */
export interface PackedGroup {
  readonly shotIds: number[];
  /** 为 true 时这一组接在已有的最后一组之后（并入它），而不是新建。 */
  readonly joinsOpenGroup: boolean;
}

/** 从分镜脚本参数中读取单组最长时长；旧记录没有该字段时用默认值。 */
export function groupMaxSecondsOf(params: Pick<StoryboardParams, 'groupMaxSeconds'> | null | undefined): number {
  const value = params?.groupMaxSeconds;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_GROUP_MAX_SECONDS;
}

/** 镜头总时长，保留 1 位小数。 */
export function sumSeconds(shots: ReadonlyArray<{ readonly durationSeconds: number }>): number {
  return Math.round(shots.reduce((sum, shot) => sum + shot.durationSeconds, 0) * 10) / 10;
}

/**
 * 把镜头按顺序打包成组：总时长不超过上限；超出时优先在场次变化处断开（断开前的部分不少于上限的一半），否则直接断开。
 * @param shots 按序号排列的镜头。
 * @param maxSeconds 单组最长时长。
 * @param openSeconds 已有的最后一组已用的时长；大于 0 时第一组尝试并入它。
 * @param openScene 已有的最后一组最后一个镜头的场次。
 */
export function packShots(shots: readonly GroupableShot[], maxSeconds: number, openSeconds = 0, openScene: string | null = null): PackedGroup[] {
  const groups: PackedGroup[] = [];
  let current: GroupableShot[] = [];
  let joinsOpen = openSeconds > 0;
  let used = openSeconds;
  let lastScene = openScene;

  const flush = (): void => {
    if (current.length > 0) groups.push({ shotIds: current.map((shot) => shot.id), joinsOpenGroup: joinsOpen });
    current = [];
    joinsOpen = false;
    used = 0;
  };

  for (const shot of shots) {
    if (used + shot.durationSeconds > maxSeconds + EPSILON && (current.length > 0 || joinsOpen)) {
      let carried: GroupableShot[] = [];
      // 从场次变化处断开：把本场次已进入当前组的镜头移到下一组，前提是下一组放得下，且前面的部分不太短。
      const sameScene = lastScene !== null && lastScene === shot.sceneLabel;
      if (sameScene && !joinsOpen) {
        let boundary = current.length - 1;
        while (boundary > 0 && current[boundary - 1].sceneLabel === current[boundary].sceneLabel) boundary -= 1;
        if (boundary > 0) {
          const kept = current.slice(0, boundary);
          const moved = current.slice(boundary);
          if (sumSeconds(kept) >= maxSeconds * MIN_SCENE_SPLIT_RATIO && sumSeconds(moved) + shot.durationSeconds <= maxSeconds + EPSILON) {
            current = kept;
            carried = moved;
          }
        }
      }
      flush();
      current = carried;
      used = sumSeconds(carried);
    }
    current.push(shot);
    used += shot.durationSeconds;
    lastScene = shot.sceneLabel;
  }
  flush();
  return groups;
}

/**
 * 计算让全部镜头都有分组的布局：已有的组原样保留（空组丢弃），还没有分组的镜头按顺序补在最后。
 * @param shots 按序号排列的镜头，groupId 为现有分组。
 * @param groupIds 现有分组标识，按序号排列。
 * @param maxSeconds 单组最长时长。
 */
export function planGroupLayout(shots: readonly GroupedShot[], groupIds: readonly number[], maxSeconds: number): GroupLayoutEntry[] {
  const layout: Array<{ groupId: number | null; shotIds: number[] }> = groupIds
    .map((groupId) => ({ groupId: groupId as number | null, shotIds: shots.filter((shot) => shot.groupId === groupId).map((shot) => shot.id) }))
    .filter((entry) => entry.shotIds.length > 0);
  const known = new Set(groupIds);
  const loose = shots.filter((shot) => shot.groupId === null || !known.has(shot.groupId));
  if (loose.length === 0) return layout;

  const byId = new Map(shots.map((shot) => [shot.id, shot]));
  const last = layout[layout.length - 1];
  const lastShots = last === undefined ? [] : last.shotIds.map((id) => byId.get(id) as GroupedShot);
  const packed = packShots(loose, maxSeconds, sumSeconds(lastShots), lastShots.length === 0 ? null : lastShots[lastShots.length - 1].sceneLabel);
  for (const group of packed) {
    if (group.joinsOpenGroup && last !== undefined) last.shotIds.push(...group.shotIds);
    else layout.push({ groupId: null, shotIds: group.shotIds });
  }
  return layout;
}

/** 全部重新分组的布局：不保留任何已有的组。 */
export function planRegroupLayout(shots: readonly GroupableShot[], maxSeconds: number): GroupLayoutEntry[] {
  return packShots(shots, maxSeconds).map((group) => ({ groupId: null, shotIds: group.shotIds }));
}

/**
 * 在某个镜头之前拆开所在的组：前半部分保留原组，后半部分新建一组。
 * @throws ValidationError 镜头不在任何组里，或它是组内第一个镜头。
 */
export function splitLayoutBefore(layout: readonly GroupLayoutEntry[], shotId: number): GroupLayoutEntry[] {
  const index = layout.findIndex((entry) => entry.shotIds.includes(shotId));
  const position = index < 0 ? -1 : layout[index].shotIds.indexOf(shotId);
  if (index < 0 || position <= 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '这个镜头已经是组内第一个，不需要拆分。' });
  }
  const entry = layout[index];
  return [
    ...layout.slice(0, index),
    { groupId: entry.groupId, shotIds: entry.shotIds.slice(0, position) },
    { groupId: null, shotIds: entry.shotIds.slice(position) },
    ...layout.slice(index + 1)
  ];
}

/**
 * 把一个组并入它的上一组；被并入的组从布局中消失。
 * @throws ValidationError 没有这个组，或它已经是第一组。
 */
export function mergeLayoutIntoPrevious(layout: readonly GroupLayoutEntry[], groupId: number): GroupLayoutEntry[] {
  const index = layout.findIndex((entry) => entry.groupId === groupId);
  if (index <= 0) {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: index < 0 ? '镜头组不存在。' : '这是第一组，没有可以合并的上一组。' });
  }
  return [
    ...layout.slice(0, index - 1),
    { groupId: layout[index - 1].groupId, shotIds: [...layout[index - 1].shotIds, ...layout[index].shotIds] },
    ...layout.slice(index + 1)
  ];
}
