// ------------------------------------------------------------------------
// 名称：storyboard-repository.ts
// 说明：分镜脚本、镜头与镜头声音数据访问的端口接口：生成时整份写入，用户编辑时按镜头保存。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：同步调用；每个阶段记录最多一份分镜脚本，重复写入会覆盖。
// ------------------------------------------------------------------------

import { ShotDraft, ShotEdit, ShotRecord, StoryboardScript } from '../models/storyboard';

/** 分镜脚本的数据访问接口。 */
export interface StoryboardRepository {
  /** 读取阶段记录的分镜脚本；还没有生成时返回 undefined。 */
  find(runId: number): StoryboardScript | undefined;
  /** 保存生成的整份分镜脚本，已存在时整体覆盖；在同一事务内完成。 */
  save(runId: number, episodeId: number, shots: readonly ShotDraft[], timestamp: string): void;
  /** 列出分镜脚本的镜头（含出场实体与声音），按序号升序；没有分镜脚本时为空。 */
  listShots(runId: number): ShotRecord[];
  /** 统计分镜脚本的镜头数。 */
  countShots(runId: number): number;
  /**
   * 修改一个镜头：出场实体与声音整体替换；镜头不属于该记录时返回 false。
   */
  updateShot(runId: number, shotId: number, edit: ShotEdit, timestamp: string): boolean;
  /**
   * 在分镜脚本末尾新增一个镜头，返回镜头标识。
   * @throws Error 记录还没有分镜脚本。
   */
  insertShot(runId: number, edit: ShotEdit, timestamp: string): number;
  /**
   * 删除一个镜头，后面的镜头序号依次前移；新的第 1 个镜头若接上一镜头尾帧则改为不指定。
   * 镜头不属于该记录时返回 false。
   */
  deleteShot(runId: number, shotId: number, timestamp: string): boolean;
}
