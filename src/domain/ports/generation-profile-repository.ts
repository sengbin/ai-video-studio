// ------------------------------------------------------------------------
// 名称：generation-profile-repository.ts
// 说明：生成参数数据访问的端口接口：读取与保存某个作品或集的参数值。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：同步调用；保存只改本接口涉及的字段，不动表里其他预留字段。
// ------------------------------------------------------------------------

import { ProfileTarget, ProfileValues } from '../models/generation-profile';

/** 生成参数的数据访问接口。 */
export interface GenerationProfileRepository {
  /** 读取参数值；还没有保存过返回 undefined。 */
  find(target: ProfileTarget): ProfileValues | undefined;
  /** 保存参数值（不存在时新建，存在时覆盖）。 */
  save(target: ProfileTarget, values: ProfileValues, timestamp: string): void;
  /** 读取若干镜头组的覆盖，没有保存过的组不在结果里。 */
  listByGroups(groupIds: readonly number[]): ReadonlyMap<number, ProfileValues>;
}
