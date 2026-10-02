// ------------------------------------------------------------------------
// 名称：tail-frames.js
// 说明：尾帧截取：向宿主查询需要截取尾帧的结果视频，用 <video> 与 <canvas> 截取最后一帧上传，让等待“上一组尾帧作首帧”的任务继续。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求名称与 src/app/pages/workbench-handlers.ts 一致；视频以 Base64 经消息传来（解码用 pageFormat.decodeBase64），转成 blob 地址播放（CSP 需允许 media-src blob:）；对外是 window.aiTailFrames.sync；截取失败时上报宿主，避免任务一直等待。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_PENDING = 'workbench.pendingFrames';
  const REQUEST_VIDEO = 'workbench.resultVideo';
  const REQUEST_SAVE = 'workbench.saveFrame';
  const REQUEST_FAILED = 'workbench.frameFailed';

  const FRAME_MIME_TYPE = 'image/jpeg';
  const FRAME_QUALITY = 0.92;
  /** 截取位置：结束前这么多秒，避免停在视频末尾时没有可显示的帧。 */
  const SEEK_BACK_SECONDS = 0.05;
  const EVENT_TIMEOUT_MS = 30000;

  /** 已经尝试过的结果，页面存在期间不重复截取（失败已上报宿主）。 */
  const attempted = new Set();
  let syncing = false;
  let syncAgain = false;

  /** 等待元素触发一次事件；出错或超时则拒绝。 */
  function waitFor(target, eventName) {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => finish(reject, new Error('读取视频超时')), EVENT_TIMEOUT_MS);
      const onEvent = () => finish(resolve);
      const onError = () => finish(reject, new Error('无法解码视频'));
      function finish(settle, value) {
        window.clearTimeout(timer);
        target.removeEventListener(eventName, onEvent);
        target.removeEventListener('error', onError);
        settle(value);
      }
      target.addEventListener(eventName, onEvent);
      target.addEventListener('error', onError);
    });
  }


  /** Blob 转 Base64（不含 data: 前缀）。 */
  function encodeBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('无法编码尾帧图片'));
      reader.readAsDataURL(blob);
    });
  }

  /** 从视频的最后一帧生成图片。 */
  async function captureLastFrame(videoUrl) {
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    try {
      const loaded = waitFor(video, 'loadedmetadata');
      video.src = videoUrl;
      await loaded;
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth === 0) throw new Error('视频没有可用的画面');
      const target = Math.max(0, video.duration - SEEK_BACK_SECONDS);
      const seeked = waitFor(video, 'seeked');
      video.currentTime = target;
      await seeked;
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, FRAME_MIME_TYPE, FRAME_QUALITY));
      if (!blob) throw new Error('无法生成尾帧图片');
      return { mimeType: FRAME_MIME_TYPE, width: canvas.width, height: canvas.height, data: await encodeBlob(blob) };
    } finally {
      video.removeAttribute('src');
      video.load();
    }
  }

  /** 截取一个结果视频的尾帧并上传；任何一步失败都上报宿主。 */
  async function extract(resultId) {
    let videoUrl = '';
    try {
      const source = await window.hostBridge.request(REQUEST_VIDEO, { resultId });
      videoUrl = URL.createObjectURL(new Blob([window.pageFormat.decodeBase64(source.data)], { type: source.mimeType }));
      const frame = await captureLastFrame(videoUrl);
      await window.hostBridge.request(REQUEST_SAVE, { resultId, ...frame });
    } catch (error) {
      const reason = error && error.message ? error.message : '';
      try {
        await window.hostBridge.request(REQUEST_FAILED, { resultId, reason });
      } catch {
        // 宿主不可用时无法上报，任务保持等待。
      }
    } finally {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    }
  }

  /** 查询并处理全部需要截取尾帧的结果视频；正在处理时登记再来一轮。 */
  async function sync() {
    if (syncing) {
      syncAgain = true;
      return;
    }
    syncing = true;
    try {
      do {
        syncAgain = false;
        let pending;
        try {
          pending = await window.hostBridge.request(REQUEST_PENDING);
        } catch {
          return;
        }
        for (const { resultId } of pending) {
          if (attempted.has(resultId)) continue;
          attempted.add(resultId);
          await extract(resultId);
        }
      } while (syncAgain);
    } finally {
      syncing = false;
    }
  }

  window.aiTailFrames = { sync };
})();
