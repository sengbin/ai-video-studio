// ------------------------------------------------------------------------
// 名称：work-text-model-repository.ts
// 说明：作品文本模型选择的数据访问接口：每个作品最多保存一个文本模型的键，没有则沿用全局默认。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：键的格式见 rules/text-model-selection.ts；作品被删除时选择随之清除。
// ------------------------------------------------------------------------

/** 作品文本模型选择仓库。 */
export interface WorkTextModelRepository {
  /** 读取作品单独选择的文本模型键；没有单独选择返回 null。 */
  find(workId: number): string | null;

  /**
   * 保存或清除作品的文本模型选择。
   * @param workId 作品标识，必须存在。
   * @param modelKey 文本模型键；null 表示清除，沿用全局默认。
   */
  save(workId: number, modelKey: string | null): void;
}
