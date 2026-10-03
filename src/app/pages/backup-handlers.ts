// ------------------------------------------------------------------------
// 名称：backup-handlers.ts
// 说明：数据备份页的请求处理：读取概览，备份到文件，选择并校验备份文件，确认恢复、取消恢复、重新加载窗口；确认与取消恢复都必须带标识。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：不依赖 VS Code；请求名称需与 resources/backup/backup.js 一致；恢复的文件路径只在宿主内保存，页面确认时不回传路径。
// ------------------------------------------------------------------------

import { FORM_LEVEL_ERROR_KEY, ValidationError } from '../../domain/errors';
import { readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { BackupService } from '../services/backup-service';

/** 备份页使用的请求名称，需与 resources/backup/backup.js 一致。 */
export const BACKUP_REQUESTS = {
  load: 'backup.load',
  export: 'backup.export',
  chooseRestoreFile: 'backup.chooseRestoreFile',
  restore: 'backup.restore',
  cancelRestore: 'backup.cancelRestore',
  reloadWindow: 'backup.reloadWindow'
} as const;

/**
 * 在路由器上注册备份页的请求处理函数。
 * @param router 面板的请求路由器。
 * @param service 备份服务。
 */
export function registerBackupHandlers(router: MessageRouter, service: BackupService): void {
  router.register(BACKUP_REQUESTS.load, () => service.getOverview());
  router.register(BACKUP_REQUESTS.export, () => service.backup());
  router.register(BACKUP_REQUESTS.chooseRestoreFile, () => service.chooseRestoreFile());
  // 确认与取消都要带标识：确认带选择备份文件时返回的 candidate.token，取消带概览里的 pendingRestore.token。
  router.register(BACKUP_REQUESTS.restore, (payload) => ({ pendingRestore: service.restore(readToken(payload)) }));
  router.register(BACKUP_REQUESTS.cancelRestore, (payload) => {
    service.cancelRestore(readToken(payload));
    return { cancelled: true };
  });
  router.register(BACKUP_REQUESTS.reloadWindow, async () => {
    await service.reloadWindow();
    return { requested: true };
  });
}

/** 读取请求载荷里的恢复标识；缺失或不是非空文本时抛出校验错误。 */
function readToken(payload: unknown): string {
  const token = readRecord(payload).token;
  if (typeof token !== 'string' || token === '') {
    throw new ValidationError({ [FORM_LEVEL_ERROR_KEY]: '缺少恢复标识，请重新操作。' });
  }
  return token;
}
