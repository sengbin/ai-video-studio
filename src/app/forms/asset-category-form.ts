// ------------------------------------------------------------------------
// 名称：asset-category-form.ts
// 说明：资产分类表单的定义：创建分类、编辑分类（只有名称一个字段），名称在同类型内唯一。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：分类属于某个资产类型，由创建时的入口决定、之后不能修改；字段约束取自领域规则常量，保证界面与宿主校验一致。
// ------------------------------------------------------------------------

import { ASSET_KIND_LABELS, AssetKind } from '../../domain/models/asset';
import { ASSET_CATEGORY_NAME_MAX_LENGTH } from '../../domain/rules/asset-category-rules';
import { readAssetKind } from '../../domain/rules/asset-rules';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { AssetCategoryService, DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE } from '../services/asset-category-service';
import { FormDefinition, FormFactory, SyncFormCatalog } from './form-definition';
import { FormSchema } from './form-schema';

/** 资产分类表单在表单目录中的名称，页面据此请求打开。 */
export const ASSET_CATEGORY_FORM_NAMES = {
  create: 'assetCategory.create',
  edit: 'assetCategory.edit'
} as const;

const SUBMIT_LABEL = '保存';

/** 构造分类表单的字段描述。 */
function createCategorySchema(title: string, kind: AssetKind): FormSchema {
  return {
    title,
    submitLabel: SUBMIT_LABEL,
    fields: [
      {
        key: 'name',
        label: '分类名称',
        description: `${ASSET_KIND_LABELS[kind]}分类的名称，同一类型内不能重复，最多 ${ASSET_CATEGORY_NAME_MAX_LENGTH} 字`,
        control: 'text',
        required: true,
        maxLength: ASSET_CATEGORY_NAME_MAX_LENGTH,
        checkUnique: true
      }
    ]
  };
}

/** 创建“创建分类”表单的定义。 */
function createNewCategoryForm(categories: AssetCategoryService, kind: AssetKind): FormDefinition {
  return {
    schema: createCategorySchema(`创建${ASSET_KIND_LABELS[kind]}分类`, kind),
    initialValues: {},
    checkField: (key, value) => (key === 'name' && !categories.isNameAvailable(kind, value) ? DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE : undefined),
    submit: (values) => {
      categories.createCategory(kind, values);
    }
  };
}

/** 创建“编辑分类”表单的定义；类型不能修改。 */
function createEditCategoryForm(categories: AssetCategoryService, categoryId: number): FormDefinition {
  const category = categories.getCategory(categoryId);
  return {
    schema: createCategorySchema(`编辑${ASSET_KIND_LABELS[category.kind]}分类`, category.kind),
    initialValues: { name: category.name },
    checkField: (key, value) =>
      key === 'name' && !categories.isNameAvailable(category.kind, value, category.id) ? DUPLICATE_ASSET_CATEGORY_NAME_MESSAGE : undefined,
    submit: (values) => {
      categories.updateCategory(category.id, values);
    }
  };
}

/**
 * 创建资产分类表单目录：创建的参数为 `{ kind }`，编辑的参数为 `{ categoryId }`。
 * @param categories 资产分类服务。
 */
export function createAssetCategoryFormCatalog(categories: AssetCategoryService): SyncFormCatalog {
  return new Map<string, FormFactory>([
    [ASSET_CATEGORY_FORM_NAMES.create, (params) => createNewCategoryForm(categories, readAssetKind(readRecord(params ?? {}).kind))],
    [
      ASSET_CATEGORY_FORM_NAMES.edit,
      (params) => createEditCategoryForm(categories, readEntityId({ id: readRecord(params ?? {}).categoryId }, '分类'))
    ]
  ]);
}
