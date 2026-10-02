// ------------------------------------------------------------------------
// 名称：project-repository.ts
// 说明：项目数据访问的端口接口，领域和应用层依赖它，不依赖具体存储。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：当前只有 SQLite 实现，方法为同步调用。
// ------------------------------------------------------------------------

import { Project, ProjectDeletionImpact, ProjectInput, ProjectSummary } from '../models/project';

/** 项目的数据访问接口。 */
export interface ProjectRepository {
  /** 列出全部项目及其作品数，按更新时间倒序。 */
  listSummaries(): ProjectSummary[];
  /** 按标识查找项目；不存在返回 undefined。 */
  findById(id: number): Project | undefined;
  /** 按名称精确查找项目；不存在返回 undefined。 */
  findByName(name: string): Project | undefined;
  /** 新增项目并返回保存后的记录。 */
  insert(input: ProjectInput, timestamp: string): Project;
  /** 修改项目并返回保存后的记录；项目不存在时返回 undefined。 */
  update(id: number, input: ProjectInput, timestamp: string): Project | undefined;
  /** 删除项目及其下全部内容；返回是否删除了记录。 */
  remove(id: number): boolean;
  /** 统计删除项目时会一并删除的内容数量。 */
  countDeletionImpact(id: number): ProjectDeletionImpact;
}
