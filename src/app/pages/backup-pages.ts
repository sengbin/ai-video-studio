// ------------------------------------------------------------------------
// 名称：backup-pages.ts
// 说明：数据备份页的入口：打开或聚焦数据备份页。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：请求处理在 backup-handlers.ts；页面操作后自行重新读取概览，不需要订阅数据变化。
// ------------------------------------------------------------------------

import { MessageRouter } from '../messaging/message-router';
import { BACKUP_PAGE_RESOURCES } from '../panels/page-resources';
import { PanelManager } from '../panels/panel-manager';
import { BackupService } from '../services/backup-service';
import { registerBackupHandlers } from './backup-handlers';

const BACKUP_PANEL_KEY = 'data-backup';
const BACKUP_VIEW_TYPE = 'aigcVideoStudio.dataBackup';
const BACKUP_TITLE = '数据备份';
const BACKUP_DESCRIPTION = '把数据库备份到文件，或从备份文件恢复；备份只含数据库，不含已下载的结果视频文件。';

/** 数据备份页的入口。 */
export class BackupPages {
  constructor(
    private readonly service: BackupService,
    private readonly panels: PanelManager
  ) {}

  /** 打开数据备份页；已打开时聚焦。 */
  show(): void {
    if (this.panels.reveal(BACKUP_PANEL_KEY)) {
      return;
    }
    const router = new MessageRouter();
    registerBackupHandlers(router, this.service);
    this.panels.open({
      key: BACKUP_PANEL_KEY,
      viewType: BACKUP_VIEW_TYPE,
      title: BACKUP_TITLE,
      description: BACKUP_DESCRIPTION,
      styles: BACKUP_PAGE_RESOURCES.styles,
      scripts: BACKUP_PAGE_RESOURCES.scripts,
      router
    });
  }
}
