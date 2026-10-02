// ------------------------------------------------------------------------
// 名称：settings-pages.ts
// 说明：模型设置页（P6）的入口：打开或聚焦设置页。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求处理在 settings-handlers.ts；设置即时保存，页面不需要订阅数据变化。
// ------------------------------------------------------------------------

import { MessageRouter } from '../messaging/message-router';
import { SETTINGS_PAGE_RESOURCES } from '../panels/page-resources';
import { PanelManager } from '../panels/panel-manager';
import { SettingsServices, registerSettingsHandlers } from './settings-handlers';

const SETTINGS_PANEL_KEY = 'settings';
const SETTINGS_VIEW_TYPE = 'aigcVideoStudio.settings';
const SETTINGS_TITLE = '模型设置';
const SETTINGS_DESCRIPTION = '配置生成文字内容的 Copilot 模型，以及图像、音频、视频模型的服务商和访问密钥，修改后立即保存。';

/** 设置页的入口。 */
export class SettingsPages {
  constructor(
    private readonly services: SettingsServices,
    private readonly panels: PanelManager
  ) {}

  /** 打开设置页；已打开时聚焦。 */
  show(): void {
    if (this.panels.reveal(SETTINGS_PANEL_KEY)) {
      return;
    }
    const router = new MessageRouter();
    registerSettingsHandlers(router, this.services);
    this.panels.open({
      key: SETTINGS_PANEL_KEY,
      viewType: SETTINGS_VIEW_TYPE,
      title: SETTINGS_TITLE,
      description: SETTINGS_DESCRIPTION,
      styles: SETTINGS_PAGE_RESOURCES.styles,
      scripts: SETTINGS_PAGE_RESOURCES.scripts,
      router
    });
  }
}
