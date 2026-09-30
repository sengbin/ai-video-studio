// ------------------------------------------------------------------------
// 名称：settings-handlers.ts
// 说明：模型设置页（P6）的请求处理：读取文本生成设置视图、即时保存修改。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：不依赖 VS Code；图像、音频、视频模型本阶段只有接口，页面显示“尚未接入模型”，没有对应请求。
// ------------------------------------------------------------------------

import { MessageRouter } from '../messaging/message-router';
import { TextSettingsService } from '../services/text-settings-service';

/** 设置页使用的请求名称，需与 resources/settings/settings.js 一致。 */
export const SETTINGS_REQUESTS = {
  load: 'settings.load',
  update: 'settings.update'
} as const;

/**
 * 在路由器上注册设置页的请求处理函数。
 * @param router 面板的请求路由器。
 * @param service 文本生成设置服务。
 */
export function registerSettingsHandlers(router: MessageRouter, service: TextSettingsService): void {
  router.register(SETTINGS_REQUESTS.load, () => service.getView());

  router.register(SETTINGS_REQUESTS.update, async (payload) => {
    await service.update(payload);
    return { saved: true };
  });
}
