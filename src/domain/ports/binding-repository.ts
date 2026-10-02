// ------------------------------------------------------------------------
// 名称：binding-repository.ts
// 说明：实体绑定数据访问的端口接口：按集列出、读取校验上下文、新增、删除、切换主资产。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：同步调用；同一（集，实体，用途）下最多一条主资产，由仓库在新增、删除、切换时维护。
// ------------------------------------------------------------------------

import { BindingContext, BindingEntityCandidate, BindingEntityDetail, BindingRecord, NewBinding } from '../models/binding';

/** 实体绑定的数据访问接口。 */
export interface BindingRepository {
  /** 列出一集的全部绑定，按实体名称、用途、主资产优先排序。 */
  listByEpisode(episodeId: number): BindingRecord[];
  /** 按标识读取绑定；不存在返回 undefined。 */
  findById(id: number): BindingRecord | undefined;
  /** 读取绑定校验的上下文；集或实体不存在，或实体不属于该集所在的作品时返回 undefined。 */
  findContext(episodeId: number, entityId: number): BindingContext | undefined;
  /** 读取实体的设定（含所属项目）；集或实体不存在，或实体不属于该集所在的作品时返回 undefined。 */
  findEntityDetail(episodeId: number, entityId: number): BindingEntityDetail | undefined;
  /** 查找一集内某实体与某资产的绑定（任意用途）；没有返回 undefined。 */
  findExisting(episodeId: number, entityId: number, assetId: number): BindingRecord | undefined;
  /** 新增绑定并返回标识；该实体在本集、该用途下还没有绑定时自动成为主资产。 */
  insert(binding: NewBinding, timestamp: string): number;
  /** 删除绑定；删除的是主资产且还有其他绑定时，最早的一条成为主资产。绑定不存在返回 false。 */
  remove(id: number): boolean;
  /** 把绑定设为主资产，同一（集，实体，用途）下原来的主资产取消；绑定不存在返回 false。 */
  setPrimary(id: number): boolean;
  /** 列出集所在作品的启用中的实体，用于按名称自动匹配。 */
  listEntityCandidates(episodeId: number): BindingEntityCandidate[];
  /** 读取集所在作品的项目；集不存在返回 undefined。 */
  findProjectId(episodeId: number): number | undefined;
}
