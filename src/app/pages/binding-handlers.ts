// ------------------------------------------------------------------------
// 名称：binding-handlers.ts
// 说明：实体绑定的请求处理：读取一集的绑定视图与绑定列表、绑定、解除、切换主资产、按名称自动匹配出建议。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不依赖 VS Code；绑定界面位于视频生成工作台，工作台的路由器上一并注册本组请求；请求载荷中的标识由服务层校验。
// ------------------------------------------------------------------------

import { readEntityId, readRecord } from '../../domain/rules/field-readers';
import { MessageRouter } from '../messaging/message-router';
import { BindingService } from '../services/binding-service';

/** 绑定使用的请求名称。 */
export const BINDING_REQUESTS = {
  view: 'bindings.view',
  list: 'bindings.list',
  bind: 'bindings.bind',
  unbind: 'bindings.unbind',
  setPrimary: 'bindings.setPrimary',
  suggest: 'bindings.suggest'
} as const;

/** 宿主推送的事件名称：绑定变化后要求页面刷新。 */
export const BINDING_EVENTS = {
  changed: 'bindings.changed'
} as const;

/**
 * 在路由器上注册实体绑定的请求处理函数。
 * @param router 页面的请求路由器。
 * @param service 绑定服务。
 */
export function registerBindingHandlers(router: MessageRouter, service: BindingService): void {
  const readEpisodeId = (payload: unknown): number => readEntityId({ id: readRecord(payload).episodeId }, '集');

  router.register(BINDING_REQUESTS.view, (payload) => service.getEpisodeView(readEpisodeId(payload)));

  router.register(BINDING_REQUESTS.list, (payload) => ({ bindings: service.listBindings(readEpisodeId(payload)) }));

  router.register(BINDING_REQUESTS.bind, (payload) => service.bind(payload));

  router.register(BINDING_REQUESTS.unbind, (payload) => {
    service.unbind(readEntityId(payload, '绑定'));
    return { unbound: true };
  });

  router.register(BINDING_REQUESTS.setPrimary, (payload) => service.setPrimary(readEntityId(payload, '绑定')));

  router.register(BINDING_REQUESTS.suggest, (payload) => ({ suggestions: service.suggestMatches(readEpisodeId(payload)) }));
}
