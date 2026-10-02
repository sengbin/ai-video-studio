// ------------------------------------------------------------------------
// 名称：shot-grouping.ts
// 说明：镜头分组的持久化操作：读取现有分组布局、补全分组（生成后、新增或删除镜头后）、全部重新分组。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：只负责读取现有分组、调用规则计算布局并写回；拆分、合并由生成服务先检查生成记录再写回。
// ------------------------------------------------------------------------

import { GroupLayoutEntry } from '../../domain/models/storyboard';
import { StoryboardRepository } from '../../domain/ports/storyboard-repository';
import { planGroupLayout, planRegroupLayout } from '../../domain/rules/shot-group-rules';

/** 读取一份分镜脚本当前的分组布局。 */
export function readGroupLayout(storyboards: StoryboardRepository, runId: number): GroupLayoutEntry[] {
  return storyboards.listGroups(runId).map((group) => ({ groupId: group.id, shotIds: group.shotIds }));
}

/**
 * 让全部镜头都有分组：保留已有的组，丢弃空组，把还没有分组的镜头按顺序补在最后。没有变化时不写库。
 * @param maxSeconds 单组最长时长。
 */
export function syncShotGroups(storyboards: StoryboardRepository, runId: number, maxSeconds: number, timestamp: string): void {
  const shots = storyboards.listShots(runId);
  if (shots.length === 0) return;
  const groups = storyboards.listGroups(runId);
  const groupOf = new Map(groups.flatMap((group) => group.shotIds.map((shotId) => [shotId, group.id] as const)));
  const layout = planGroupLayout(
    shots.map((shot) => ({ id: shot.id, sceneLabel: shot.sceneLabel, durationSeconds: shot.durationSeconds, groupId: groupOf.get(shot.id) ?? null })),
    groups.map((group) => group.id),
    maxSeconds
  );
  const unchanged =
    layout.length === groups.length && layout.every((entry, index) => entry.groupId === groups[index].id && entry.shotIds.length === groups[index].shotIds.length);
  if (!unchanged) storyboards.applyGroupLayout(runId, layout, timestamp);
}

/** 丢弃现有分组，按单组最长时长重新分组。 */
export function regroupShots(storyboards: StoryboardRepository, runId: number, maxSeconds: number, timestamp: string): void {
  const shots = storyboards.listShots(runId);
  storyboards.applyGroupLayout(runId, planRegroupLayout(shots, maxSeconds), timestamp);
}
