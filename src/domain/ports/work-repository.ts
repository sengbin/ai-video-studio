// ------------------------------------------------------------------------
// 名称：work-repository.ts
// 说明：作品数据访问的端口接口：作品的查询、连同素材创建和删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：同步调用；创建作品、第 1 集与素材必须在同一事务内完成，由实现保证。
// ------------------------------------------------------------------------

import { NewWorkSource, Work, WorkInput } from '../models/work';

/** 作品的数据访问接口。 */
export interface WorkRepository {
  /** 列出项目下的全部作品，按创建时间倒序。 */
  listByProject(projectId: number): Work[];
  /** 按标识查找作品；不存在返回 undefined。 */
  findById(id: number): Work | undefined;
  /** 在项目内按名称精确查找作品；不存在返回 undefined。 */
  findByName(projectId: number, name: string): Work | undefined;
  /** 创建作品与素材；单个短视频同时创建第 1 集。 */
  insert(projectId: number, input: WorkInput, sources: readonly NewWorkSource[], timestamp: string): Work;
  /** 删除作品及其下全部内容；返回是否删除了记录。 */
  remove(id: number): boolean;
}
