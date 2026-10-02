// ------------------------------------------------------------------------
// 名称：asset-list-pages.ts
// 说明：资产列表页的入口：每种资产类型一个面板，列出所有项目中该类型的资产；新建、编辑表单都在页内弹出。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求处理在 asset-list-handlers.ts 与 form-handlers.ts；把资产与项目的变化推送给页面。
// ------------------------------------------------------------------------

import { ASSET_KIND_LABELS, AssetKind } from '../../domain/models/asset';
import { createAssetFormCatalog } from '../forms/asset-form';
import { registerFormHandlers } from '../forms/form-handlers';
import { MessageRouter } from '../messaging/message-router';
import { ASSET_LIST_PAGE_RESOURCES } from '../panels/page-resources';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { AssetGenerationService } from '../services/asset-generation-service';
import { AssetPromptService } from '../services/asset-prompt-service';
import { AssetService } from '../services/asset-service';
import { ProjectService } from '../services/project-service';
import { ASSET_LIST_EVENTS, AssetListRequest, registerAssetListHandlers } from './asset-list-handlers';

const ASSET_LIST_VIEW_TYPE = 'aiVideoStudio.assetList';

/** 各类型的页面描述，显示在页面顶部标题栏里。 */
const ASSET_LIST_DESCRIPTIONS: Readonly<Record<AssetKind, string>> = {
  character: '所有项目中的角色资产，可新建、修改和删除，作为实体绑定的形象来源。',
  scene: '所有项目中的场景资产，可新建、修改和删除，作为实体绑定的形象来源。',
  prop: '所有项目中的道具资产，可新建、修改和删除，作为实体绑定的形象来源。',
  effect: '所有项目中的特效资产，可新建、修改和删除，作为实体绑定的形象来源。',
  audio: '所有项目中的音频资产（音色参考、背景音乐、音效），可新建、修改和删除。'
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
   * @param services 项目、资产与提示词生成服务。
   * @param panels 面板管理器。
   */
  constructor(
    private readonly services: {
      readonly projects: ProjectService;
      readonly assets: AssetService;
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

    const { projects, assets, prompts } = this.services;
    const entry: OpenedAssetList = { panel: undefined, pending: request };
    const router = new MessageRouter();
    registerAssetListHandlers(router, kind, this.services, {
      takePending: () => {
        const taken = entry.pending;
        entry.pending = undefined;
        return taken;
      }
    });
    registerFormHandlers(router, createAssetFormCatalog({ projects, assets, prompts }));

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
    // 项目改名或删除（连同资产）也会影响列表。
    const unsubscribes = [projects.onDidChangeProjects(notifyChanged), assets.onDidChangeAssets(notifyChanged)];
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
