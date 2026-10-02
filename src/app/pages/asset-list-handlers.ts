// ------------------------------------------------------------------------
// 名称：asset-list-handlers.ts
// 说明：资产列表页的请求处理：读取某类型全部项目的资产、取走待执行动作、删除（先取使用情况，再删除）。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；一个页面绑定一种资产类型，请求不需要再带类型；新建、编辑表单由页面用表单请求在弹出页面中完成，删除确认在页面内对话框完成。
// ------------------------------------------------------------------------

import { AssetKind, AssetListItem } from '../../domain/models/asset';
import { readEntityId } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { AssetService } from '../services/asset-service';
import { ProjectService } from '../services/project-service';

/** 资产列表页使用的请求名称，需与 resources/asset-list/asset-list.js 一致。 */
export const ASSET_LIST_REQUESTS = {
  load: 'assets.load',
  takePending: 'assets.takePending',
  prepareDelete: 'assets.prepareDelete',
  delete: 'assets.delete'
} as const;

/** 宿主推送给资产列表页的事件名称：changed 要求刷新数据，action 要求执行动作。 */
export const ASSET_LIST_EVENTS = {
  changed: 'assets.changed',
  action: 'assets.action'
} as const;

/** 页面打开或已打开时需要它立即执行的动作：弹出“新建资产”表单。 */
export type AssetListAction = 'create';

/** 页面打开或已打开时需要它处理的请求。 */
export interface AssetListRequest {
  readonly action?: AssetListAction;
}

/** 列表中的一行：资产加所属项目的名称。 */
export interface AssetListRow extends AssetListItem {
  readonly projectName: string;
}

/** 资产列表页需要外部提供的能力。 */
export interface AssetListActions {
  /** 取走页面打开前登记的待处理请求；没有时返回 undefined，取走后不再返回。 */
  takePending(): AssetListRequest | undefined;
}

/**
 * 在路由器上注册资产列表页的请求处理函数。
 * @param router 面板的请求路由器。
 * @param kind 页面绑定的资产类型。
 * @param services 项目与资产服务。
 * @param actions 外部提供的能力。
 */
export function registerAssetListHandlers(
  router: MessageRouter,
  kind: AssetKind,
  services: { readonly projects: ProjectService; readonly assets: AssetService },
  actions: AssetListActions
): void {
  const { projects, assets } = services;

  router.register(ASSET_LIST_REQUESTS.load, () => {
    const summaries = projects.listProjects();
    const names = new Map(summaries.map((project) => [project.id, project.name]));
    const rows: AssetListRow[] = assets.listAssets(kind).map((asset) => ({ ...asset, projectName: names.get(asset.projectId) ?? '' }));
    return { kind, projects: summaries.map(({ id, name }) => ({ id, name })), assets: rows };
  });

  router.register(ASSET_LIST_REQUESTS.takePending, () => ({ request: actions.takePending() }));

  router.register(ASSET_LIST_REQUESTS.prepareDelete, (payload) => assets.getDeletionImpact(readEntityId(payload, '资产')));

  router.register(ASSET_LIST_REQUESTS.delete, (payload) => {
    const asset = assets.getAsset(readEntityId(payload, '资产'));
    assets.deleteAsset(asset.id);
    return { deleted: true, name: asset.name };
  });
}
