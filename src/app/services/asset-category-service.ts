// ------------------------------------------------------------------------
// 名称：asset-category-service.ts
// 说明：资产分类应用服务：校验分类名称、检查同类型内名称唯一、创建、重命名、删除分类，并把表单选择的分类名称解析为分类标识。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code 和具体存储；分类属于某个资产类型，创建后类型不能修改；“不分类”用 null 表示，不用 0；删除分类不删除资产，归入该分类的资产变为未分类。
// ------------------------------------------------------------------------

import { ConflictError, NotFoundError, ValidationError } from '../../domain/errors';
import { AssetKind } from '../../domain/models/asset';
import { AssetCategoryDeletionImpact, AssetCategoryListItem, AssetCategoryRecord } from '../../domain/models/asset-category';
import { AssetCategoryRepository } from '../../domain/ports/asset-category-repository';
import { normalizeAssetCategoryName } from '../../domain/rules/asset-category-rules';
import { ChangeNotifier } from './change-notifier';

/** 同类型下分类重名时的提示。 */
export const DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE = '已有同名分类，请换一个名称。';

/** 资产表单中“所属分类”字段的键，提交的值是分类名称，空串表示不分类。 */
export const ASSET_CATEGORY_FIELD_KEY = 'category';

const CATEGORY_NOT_FOUND_MESSAGE = '所属分类不存在，请重新选择。';

/** 资产分类应用服务。 */
export class AssetCategoryService {
  private readonly changeNotifier = new ChangeNotifier();

  /**
   * @param repository 资产分类仓库。
   * @param now 返回当前时间的函数，测试时可注入固定时间。
   */
  constructor(
    private readonly repository: AssetCategoryRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** 订阅分类数据变化（创建、重命名、删除）；返回取消订阅的函数。 */
  onDidChangeCategories(listener: () => void): () => void {
    return this.changeNotifier.subscribe(listener);
  }

  /** 列出某类型的全部分类（含资产数量），按创建顺序。 */
  listCategories(kind: AssetKind): AssetCategoryListItem[] {
    return this.repository.list(kind);
  }

  /**
   * 读取分类。
   * @throws NotFoundError 分类不存在。
   */
  getCategory(id: number): AssetCategoryRecord {
    const category = this.repository.findById(id);
    if (category === undefined) {
      throw new NotFoundError(`分类 ${id} 不存在。`);
    }
    return category;
  }

  /**
   * 判断名称在同类型内是否可用，用于表单在字段失去焦点时检查重名。
   * @param excludeCategoryId 修改分类时排除自身。
   */
  isNameAvailable(kind: AssetKind, name: string, excludeCategoryId?: number): boolean {
    const existing = this.repository.findByName(kind, name.trim());
    return existing === undefined || existing.id === excludeCategoryId;
  }

  /**
   * 创建分类。
   * @param kind 资产类型。
   * @param rawInput 表单提交的原始内容，键为 name。
   * @throws ValidationError 名称不合法。
   * @throws ConflictError 同类型下名称重复。
   */
  createCategory(kind: AssetKind, rawInput: unknown): AssetCategoryRecord {
    const name = normalizeAssetCategoryName(rawInput);
    this.assertNameAvailable(kind, name);
    const id = this.repository.insert(kind, name, this.timestamp());
    this.changeNotifier.notify();
    return this.getCategory(id);
  }

  /**
   * 修改分类名称；类型不能修改。
   * @throws ValidationError 名称不合法。
   * @throws ConflictError 名称与同类型的其他分类重复。
   * @throws NotFoundError 分类不存在。
   */
  updateCategory(id: number, rawInput: unknown): AssetCategoryRecord {
    const category = this.getCategory(id);
    const name = normalizeAssetCategoryName(rawInput);
    this.assertNameAvailable(category.kind, name, id);
    if (!this.repository.rename(id, name, this.timestamp())) {
      throw new NotFoundError(`分类 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
    return this.getCategory(id);
  }

  /**
   * 读取删除分类前需要告知用户的名称与受影响的资产数量。
   * @throws NotFoundError 分类不存在。
   */
  getDeletionImpact(id: number): AssetCategoryDeletionImpact {
    const category = this.getCategory(id);
    return { name: category.name, assetCount: this.repository.countAssets(id) };
  }

  /**
   * 删除分类；归入该分类的资产变为未分类，资产本身保留。
   * @throws NotFoundError 分类不存在。
   */
  deleteCategory(id: number): void {
    if (!this.repository.remove(id)) {
      throw new NotFoundError(`分类 ${id} 不存在。`);
    }
    this.changeNotifier.notify();
  }

  /**
   * 把表单选择的分类名称解析为分类标识。
   * @param kind 资产类型，分类必须属于该类型。
   * @param name 表单提交的分类名称；空串表示不分类。
   * @returns 分类标识；不分类时为 null。
   * @throws ValidationError 分类不存在（例如打开表单后被删除）。
   */
  resolveCategoryId(kind: AssetKind, name: string): number | null {
    const text = name.trim();
    if (text === '') {
      return null;
    }
    const category = this.repository.findByName(kind, text);
    if (category === undefined) {
      throw new ValidationError({ [ASSET_CATEGORY_FIELD_KEY]: CATEGORY_NOT_FOUND_MESSAGE });
    }
    return category.id;
  }

  private assertNameAvailable(kind: AssetKind, name: string, excludeCategoryId?: number): void {
    if (!this.isNameAvailable(kind, name, excludeCategoryId)) {
      throw new ConflictError('name', DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE);
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}
