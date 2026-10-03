// ------------------------------------------------------------------------
// 名称：asset-list-handlers.ts
// 说明：资产列表页的请求处理：读取某类型的全部资产（带提示词与图片的状态）和该类型的分类、取走待执行动作、删除（先取使用情况，再删除）、切换资产使用的文件来源（上传、生成）、提示词后台生成的启动与取消、图片（音频）生成的提交与版本管理。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；一个页面绑定一种资产类型，请求不需要再带类型；新建、编辑表单由页面用表单请求在弹出页面中完成，删除确认在页面内对话框完成；版本列表、采用等请求直接交给资产生成服务。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, NotFoundError, ValidationError } from '../../domain/errors';
import { AssetFileSource, AssetKind, AssetListItem } from '../../domain/models/asset';
import { checkGenerationAvailability, GenerationAvailability, hasUngeneratedChanges, isPromptOutdated } from '../../domain/rules/asset-generation-rules';
import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { AssetGenerationService } from '../services/asset-generation-service';
import { AssetPromptService } from '../services/asset-prompt-service';
import { AssetService } from '../services/asset-service';
import { AssetCategoryService } from '../services/asset-category-service';

/** 资产列表页使用的请求名称，需与 resources/asset-list/ 下的脚本一致。 */
export const ASSET_LIST_REQUESTS = {
  load: 'assets.load',
  takePending: 'assets.takePending',
  prepareDelete: 'assets.prepareDelete',
  delete: 'assets.delete',
  switchSource: 'assets.switchSource',
  generatePrompt: 'assets.generatePrompt',
  cancelPrompt: 'assets.cancelPrompt',
  generateCatalog: 'assets.generateCatalog',
  generate: 'assets.generate',
  versions: 'assets.versions',
  version: 'assets.version',
  fileData: 'assets.fileData',
  referenceImage: 'assets.referenceImage',
  referenceAudio: 'assets.referenceAudio',
  saveThumbnails: 'assets.saveThumbnails',
  adopt: 'assets.adopt',
  deleteVersion: 'assets.deleteVersion',
  cancelVersion: 'assets.cancelVersion',
  retryVersion: 'assets.retryVersion'
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

/** 列表中的一行：资产加生成状态标记。 */
export interface AssetListRow extends AssetListItem {
  /** 提示词需更新：表单字段在提示词之后改过。 */
  readonly isPromptOutdated: boolean;
  /** 图片（音频）有改动未生成。 */
  readonly hasUngeneratedChanges: boolean;
  /** 能否提交图片（音频）生成及不能时的原因；有无可用模型按这一条资产（音频按其音频类型）计算。 */
  readonly availability: GenerationAvailability;
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
 * @param services 资产、分类、提示词生成和资产生成服务。
 * @param actions 外部提供的能力。
 */
export function registerAssetListHandlers(
  router: MessageRouter,
  kind: AssetKind,
  services: {
    readonly assets: AssetService;
    readonly categories: AssetCategoryService;
    readonly prompts: AssetPromptService;
    readonly generation: AssetGenerationService;
  },
  actions: AssetListActions
): void {
  const { assets, categories, prompts, generation } = services;

  router.register(ASSET_LIST_REQUESTS.load, async () => {
    // 音频资产按各自的音频类型逐条判断有无可用模型，不能按资产大类一刀切。
    const hasUsableModel = await generation.createUsableModelCheck(kind);
    const rows: AssetListRow[] = assets.listAssets(kind).map((asset) => ({
      ...asset,
      isPromptOutdated: isPromptOutdated(asset),
      hasUngeneratedChanges: hasUngeneratedChanges(asset, asset.generation),
      availability: checkGenerationAvailability(asset, asset.generation, hasUsableModel(asset))
    }));
    return { kind, assets: rows, categories: categories.listCategories(kind) };
  });

  router.register(ASSET_LIST_REQUESTS.takePending, () => ({ request: actions.takePending() }));

  router.register(ASSET_LIST_REQUESTS.prepareDelete, (payload) => assets.getDeletionImpact(readEntityId(payload, '资产')));

  router.register(ASSET_LIST_REQUESTS.delete, (payload) => {
    const asset = assets.getAsset(readEntityId(payload, '资产'));
    assets.deleteAsset(asset.id);
    return { deleted: true, name: asset.name };
  });

  // 切换使用的文件来源：上传与生成的文件都保留，只改变资产对外使用哪一组。
  router.register(ASSET_LIST_REQUESTS.switchSource, (payload) => {
    const source = readRecord(payload).source;
    if (source !== 'upload' && source !== 'generated') {
      throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '文件来源无效。' });
    }
    assets.switchFileSource(readEntityId(payload, '资产'), source as AssetFileSource);
    return { switched: true };
  });

  router.register(ASSET_LIST_REQUESTS.generatePrompt, (payload) => {
    prompts.start(readEntityId(payload, '资产'));
    return { started: true };
  });

  router.register(ASSET_LIST_REQUESTS.cancelPrompt, (payload) => {
    prompts.cancel(readEntityId(payload, '资产'));
    return { canceled: true };
  });

  const readAssetId = (payload: unknown): number => readEntityId({ id: readRecord(payload).assetId }, '资产');
  const readVersionId = (payload: unknown): number => readEntityId({ id: readRecord(payload).versionId }, '版本');

  router.register(ASSET_LIST_REQUESTS.generateCatalog, (payload) => generation.getCatalog(readAssetId(payload)));
  router.register(ASSET_LIST_REQUESTS.generate, (payload) => generation.submit(payload));
  router.register(ASSET_LIST_REQUESTS.versions, (payload) => generation.listVersions(readAssetId(payload)));
  router.register(ASSET_LIST_REQUESTS.version, (payload) => generation.getVersion(readVersionId(payload)));
  router.register(ASSET_LIST_REQUESTS.fileData, (payload) => generation.getFileData(readEntityId({ id: readRecord(payload).fileId }, '文件')));
  /** 取资产的第一个参考文件（图片或音频）的类型与 Base64 内容；没有时按 emptyMessage 报错。 */
  const readFirstReferenceFile = (payload: unknown, emptyMessage: string) => {
    const [file] = assets.getReferenceFiles(readEntityId(payload, '资产'));
    if (file === undefined) {
      throw new NotFoundError(emptyMessage);
    }
    return { mime: file.mime, data: file.content.toString('base64') };
  };
  // 列表预览点击查看原图：取资产的第一张参考图，与缩略图显示的是同一张。
  router.register(ASSET_LIST_REQUESTS.referenceImage, (payload) => readFirstReferenceFile(payload, '该资产没有参考图。'));
  // 音频列表点击试听：取资产的参考音频。
  router.register(ASSET_LIST_REQUESTS.referenceAudio, (payload) => readFirstReferenceFile(payload, '该资产还没有参考音频。'));
  router.register(ASSET_LIST_REQUESTS.saveThumbnails, (payload) => {
    generation.saveThumbnails(payload);
    return { saved: true };
  });
  router.register(ASSET_LIST_REQUESTS.adopt, (payload) => {
    generation.adopt(payload);
    return { adopted: true };
  });
  router.register(ASSET_LIST_REQUESTS.deleteVersion, (payload) => {
    generation.deleteVersion(readVersionId(payload));
    return { deleted: true };
  });
  router.register(ASSET_LIST_REQUESTS.cancelVersion, (payload) => generation.cancel(readVersionId(payload)));
  router.register(ASSET_LIST_REQUESTS.retryVersion, async (payload) => {
    await generation.retry(readVersionId(payload));
    return { retried: true };
  });
}
