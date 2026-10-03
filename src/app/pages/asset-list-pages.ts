// ------------------------------------------------------------------------
// 名称：asset-list-pages.ts
// 说明：资产列表页的入口：每种资产类型一个面板，列出该类型的全部资产（资产不属于项目）；新建、编辑资产与创建、编辑分类的表单都在页内弹出。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求处理在 asset-list-handlers.ts、asset-category-handlers.ts 与 form-handlers.ts；把资产与分类的变化推送给页面。
// ------------------------------------------------------------------------

import { ASSET_KIND_LABELS, AssetKind } from '../../domain/models/asset';
import { createAssetCategoryFormCatalog } from '../forms/asset-category-form';
import { createAssetFormCatalog } from '../forms/asset-form';
import { FormCatalog } from '../forms/form-definition';
import { registerFormHandlers } from '../forms/form-handlers';
import { MessageRouter } from '../messaging/message-router';
import { ASSET_LIST_PAGE_RESOURCES } from '../panels/page-resources';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { AssetCategoryService } from '../services/asset-category-service';
import { AssetGenerationService } from '../services/asset-generation-service';
import { AssetPromptService } from '../services/asset-prompt-service';
import { AssetService } from '../services/asset-service';
import { ProjectService } from '../services/project-service';
import { registerAssetCategoryHandlers } from './asset-category-handlers';
import { ASSET_LIST_EVENTS, AssetListRequest, registerAssetListHandlers } from './asset-list-handlers';

const ASSET_LIST_VIEW_TYPE = 'aigcVideoStudio.assetList';

/** 各类型的页面描述，显示在页面顶部标题栏里。 */
const ASSET_LIST_DESCRIPTIONS: Readonly<Record<AssetKind, string>> = {
  character: '角色资产，所有项目共用，可新建、修改和删除，作为实体绑定的形象来源。',
  scene: '场景资产，所有项目共用，可新建、修改和删除，作为实体绑定的形象来源。',
  prop: '道具资产，所有项目共用，可新建、修改和删除，作为实体绑定的形象来源。',
  effect: '特效资产，所有项目共用，可新建、修改和删除，作为实体绑定的形象来源。',
  audio: '音频资产（音色参考、背景音乐、音效），所有项目共用，可新建、修改和删除。'
};

/** 已打开的资产列表页。 */
interface OpenedAssetList {
  /** 面板句柄；面板创建完成前为 undefined。 */
  panel: OpenedPanel | undefined;
  /** 页面尚未加载完成时登记的请求，页面加载后主动取走。 */
  pending: AssetListRequest | undefined;
}

/** 资产列表页的入口集合。 */
export class AssetListPages {
  private readonly opened = new Map<AssetKind, OpenedAssetList>();

  /**
   * @param services 项目（从实体新建资产时读取视觉风格）、资产、资产分类与提示词生成服务。
   * @param panels 面板管理器。
   */
  constructor(
    private readonly services: {
      readonly projects: ProjectService;
      readonly assets: AssetService;
      readonly categories: AssetCategoryService;
      readonly prompts: AssetPromptService;
      readonly generation: AssetGenerationService;
    },
    private readonly panels: PanelManager
  ) {}

  /**
   * 打开或聚焦某种资产类型的列表页。
   * @param kind 资产类型。
   * @param request 需要页面处理的请求，如弹出新建资产表单。
   */
  show(kind: AssetKind, request?: AssetListRequest): void {
    const key = panelKey(kind);
    const existing = this.opened.get(kind);
    if (existing !== undefined && this.panels.reveal(key)) {
      if (request !== undefined) {
        existing.panel?.postEvent(ASSET_LIST_EVENTS.action, request);
      }
      return;
    }

    const { projects, assets, categories, prompts } = this.services;
    const entry: OpenedAssetList = { panel: undefined, pending: request };
    const router = new MessageRouter();
    registerAssetListHandlers(router, kind, this.services, {
      takePending: () => {
        const taken = entry.pending;
        entry.pending = undefined;
        return taken;
      }
    });
    registerAssetCategoryHandlers(router, categories);
    // 路由器只能注册一次表单请求，因此合并资产表单与分类表单两个目录。
    const catalog: FormCatalog = new Map([
      ...createAssetFormCatalog({ projects, assets, categories, prompts }),
      ...createAssetCategoryFormCatalog(categories)
    ]);
    registerFormHandlers(router, catalog);

    const panel = this.panels.open({
      key,
      viewType: ASSET_LIST_VIEW_TYPE,
      title: ASSET_KIND_LABELS[kind],
      description: ASSET_LIST_DESCRIPTIONS[kind],
      styles: ASSET_LIST_PAGE_RESOURCES.styles,
      scripts: ASSET_LIST_PAGE_RESOURCES.scripts,
      router
    });
    entry.panel = panel;
    this.opened.set(kind, entry);

    const notifyChanged = () => panel.postEvent(ASSET_LIST_EVENTS.changed);
    const unsubscribes = [assets.onDidChangeAssets(notifyChanged), categories.onDidChangeCategories(notifyChanged)];
    panel.onDidClose(() => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      this.opened.delete(kind);
    });
  }
}

/** 资产列表页的面板键。 */
function panelKey(kind: AssetKind): string {
  return `asset-list:${kind}`;
}
