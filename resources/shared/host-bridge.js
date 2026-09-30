// ------------------------------------------------------------------------
// 名称：host-bridge.js
// 说明：Webview 与扩展宿主的通信桥：封装请求/响应匹配与宿主事件订阅。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：信封格式与 src/app/messaging/envelope.ts 一致；本文件必须先于页面脚本加载。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const vscodeApi = acquireVsCodeApi();
  /** 等待响应的请求：requestId → { resolve, reject }。 */
  const pendingRequests = new Map();
  /** 事件订阅：事件名 → 处理函数数组。 */
  const eventHandlers = new Map();
  let nextRequestId = 1;

  /**
   * 请求宿主执行一个操作。
   * @param {string} name 请求名称。
   * @param {unknown} [payload] 请求载荷。
   * @returns {Promise<any>} 宿主返回的数据；失败时以宿主错误载荷（kind、message、fieldErrors）拒绝。
   */
  function request(name, payload) {
    return new Promise((resolve, reject) => {
      const requestId = nextRequestId++;
      pendingRequests.set(requestId, { resolve, reject });
      vscodeApi.postMessage({ type: 'request', requestId, name, payload });
    });
  }

  /**
   * 订阅宿主推送的事件。
   * @param {string} name 事件名称。
   * @param {(payload: any) => void} handler 处理函数。
   */
  function onEvent(name, handler) {
    const handlers = eventHandlers.get(name) || [];
    handlers.push(handler);
    eventHandlers.set(name, handlers);
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === 'response') {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(message.error);
    } else if (message.type === 'event') {
      for (const handler of eventHandlers.get(message.name) || []) handler(message.payload);
    }
  });

  window.hostBridge = { request, onEvent };
})();
