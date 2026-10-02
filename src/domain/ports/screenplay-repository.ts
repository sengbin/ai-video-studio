// ------------------------------------------------------------------------
// 名称：screenplay-repository.ts
// 说明：剧本包、集与脚本实体数据访问的端口接口：剧本阶段逐步保存产出，确认采用时把抽取结果合并到集和实体，确认后直接编辑集和实体。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：同步调用；merge 不自带事务，由调用方放在确认采用的事务内（见 StageRunRepository.approve）。
// ------------------------------------------------------------------------

import {
  EntityEdit,
  EntityKind,
  EntityRecord,
  EpisodeEdit,
  EpisodeRecord,
  Screenplay,
  ScreenplayStructure,
  ScreenplayText
} from '../models/screenplay';

/** 剧本包、集与实体的数据访问接口。 */
export interface ScreenplayRepository {
  /** 读取阶段记录的剧本包；还没有生成正文时返回 undefined。 */
  find(runId: number): Screenplay | undefined;
  /** 保存生成的剧本包正文；抽取结果为空，已存在时覆盖。 */
  create(runId: number, text: ScreenplayText, timestamp: string): void;
  /** 保存抽取结果。 */
  saveStructure(runId: number, structure: ScreenplayStructure, timestamp: string): void;
  /** 清除抽取结果，用于重新抽取。 */
  clearStructure(runId: number, timestamp: string): void;
  /** 更新剧本包正文。 */
  updateFullText(runId: number, fullText: string, timestamp: string): void;

  /** 列出作品的集，按序号升序。 */
  listEpisodes(workId: number): EpisodeRecord[];
  /** 列出作品的实体，按类型与标识排序。 */
  listEntities(workId: number): EntityRecord[];
  /** 修改作品的一集；集不存在时返回 false。 */
  updateEpisode(workId: number, episodeId: number, edit: EpisodeEdit, timestamp: string): boolean;
  /**
   * 修改作品的一个实体；实体不存在时返回 false。
   * @throws ConflictError 同类型下名称重复。
   */
  updateEntity(workId: number, entityId: number, edit: EntityEdit, timestamp: string): boolean;
  /** 在作品末尾新增一集，返回集标识。 */
  insertEpisode(workId: number, edit: EpisodeEdit, timestamp: string): number;
  /** 删除作品的一集（连同它的分镜脚本、绑定等下游数据），后面的集序号依次前移；集不存在时返回 false。 */
  deleteEpisode(workId: number, episodeId: number): boolean;
  /**
   * 新增作品的一个实体，返回实体标识。
   * @throws ConflictError 同类型下名称重复。
   */
  insertEntity(workId: number, kind: EntityKind, edit: EntityEdit, timestamp: string): number;
  /** 统计实体被镜头、镜头声音和资产绑定引用的次数。 */
  countEntityReferences(entityId: number): number;
  /** 删除作品的一个实体；实体不存在时返回 false。 */
  deleteEntity(workId: number, entityId: number): boolean;

  /**
   * 把阶段记录的抽取结果合并到作品的集和实体，并记录合并时间：
   * 集按序号更新或新增，不删除；实体按（类型，名称）更新或新增，保留已有标识，不再出现的置为停用。
   * @throws Error 抽取结果为空。
   */
  merge(runId: number, timestamp: string): void;
}
