// ------------------------------------------------------------------------
// 名称：asset-category-handlers.ts
// 说明：资产分类的请求处理：删除分类前读取受影响的资产数量，再删除分类。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code；创建、编辑分类由页面用表单请求（asset-category-form.ts）完成，分类列表随资产列表一起加载（asset-list-handlers.ts）；删除确认在页面内对话框完成。
// ------------------------------------------------------------------------

import { readEntityId } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { AssetCategoryService } from '../services/asset-category-service';

/** 资产分类使用的请求名称，需与 resources/asset-list/asset-categories.js 一致。 */
export const ASSET_CATEGORY_REQUESTS = {
  prepareDelete: 'assetCategories.prepareDelete',
  delete: 'assetCategories.delete'
} as const;

/**
 * 在路由器上注册资产分类的请求处理函数。
 * @param router 面板的请求路由器。
 * @param categories 资产分类服务。
 */
export function registerAssetCategoryHandlers(router: MessageRouter, categories: AssetCategoryService): void {
  router.register(ASSET_CATEGORY_REQUESTS.prepareDelete, (payload) => categories.getDeletionImpact(readEntityId(payload, '分类')));

  router.register(ASSET_CATEGORY_REQUESTS.delete, (payload) => {
    const category = categories.getCategory(readEntityId(payload, '分类'));
    categories.deleteCategory(category.id);
    return { deleted: true, name: category.name };
  });
}
