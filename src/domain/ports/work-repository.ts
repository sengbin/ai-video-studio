// ------------------------------------------------------------------------
// 名称：work-repository.ts
// 说明：作品数据访问的端口接口：作品的查询、连同素材创建、修改和删除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：同步调用；创建作品与第 1 集、修改作品形态时增删第 1 集，都必须在同一事务内完成，由实现保证。
// ------------------------------------------------------------------------

import { NewWorkSource, Work, WorkInput, WorkSourceKind, WorkSourceType, WorkUpdate } from '../models/work';

/** 作品的数据访问接口。 */
export interface WorkRepository {
  /** 列出项目下的全部作品，按创建时间倒序。 */
  listByProject(projectId: number): Work[];
  /** 列出所有项目中指定素材来源的作品，按创建时间倒序。 */
  listBySource(sourceType: WorkSourceType): Work[];
  /** 列出所有项目、所有素材来源的作品，按创建时间倒序。 */
  listAll(): Work[];
  /** 按标识查找作品；不存在返回 undefined。 */
  findById(id: number): Work | undefined;
  /** 在项目内按名称精确查找作品；不存在返回 undefined。 */
  findByName(projectId: number, name: string): Work | undefined;
  /** 创建作品与素材；单个短视频同时创建第 1 集。 */
  insert(projectId: number, input: WorkInput, sources: readonly NewWorkSource[], timestamp: string): Work;
  /**
   * 修改作品名称与形态；形态变化时同步增删单个短视频的第 1 集，名称变化时同步第 1 集仍等于旧作品名的标题；
   * input 带 images 时，用它整体替换作品原有的灵感图片。
   * @returns 修改后的作品；不存在返回 undefined。
   */
  update(id: number, input: WorkUpdate, timestamp: string): Work | undefined;
  /** 按保存顺序读取作品指定类别的素材文件。 */
  listSources(workId: number, kind: WorkSourceKind): NewWorkSource[];
  /** 删除作品及其下全部内容；返回是否删除了记录。 */
  remove(id: number): boolean;
}
