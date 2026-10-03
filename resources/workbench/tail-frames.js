// ------------------------------------------------------------------------
// 名称：tail-frames.js
// 说明：尾帧截取：向宿主查询需要截取尾帧的结果视频，用 <video> 与 <canvas> 截取最后一帧上传，让等待“上一组尾帧作首帧”的任务继续。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求名称与 src/app/pages/workbench-handlers.ts 一致；视频以 Base64 经消息传来（解码用 pageFormat.decodeBase64），转成 blob 地址播放（CSP 需允许 media-src blob:）；对外是 window.aiTailFrames.sync；截取失败时上报宿主（任务随之失败），上报没有成功时下一次同步会再试；只防同一时刻重复截取同一个结果。
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

  /** 正在截取的结果，只用来防止同一时刻重复截取同一个结果；结束后（无论成败）立即清除，下次同步仍可重试。 */
  const extracting = new Set();
  let syncing = false;
  let syncAgain = false;

  /**
   * 等待元素触发一次事件；出错或超时则拒绝。
   * @returns {{ promise: Promise<void>, dispose: () => void }} dispose 清除定时器与监听，调用方提前退出时必须调用。
   */
  function waitFor(target, eventName) {
    let dispose = () => {};
    const promise = new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => finish(reject, new Error('读取视频超时')), EVENT_TIMEOUT_MS);
      const onEvent = () => finish(resolve);
      const onError = () => finish(reject, new Error('无法解码视频'));
      dispose = () => {
        window.clearTimeout(timer);
        target.removeEventListener(eventName, onEvent);
        target.removeEventListener('error', onError);
      };
      function finish(settle, value) {
        dispose();
        settle(value);
      }
      target.addEventListener(eventName, onEvent);
      target.addEventListener('error', onError);
    });
    return { promise, dispose };
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
    const waiters = [];
    const waitForEvent = (eventName) => {
      const waiter = waitFor(video, eventName);
      waiters.push(waiter);
      return waiter.promise;
    };
    let canvas = null;
    try {
      const loaded = waitForEvent('loadedmetadata');
      video.src = videoUrl;
      await loaded;
      if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth === 0) throw new Error('视频没有可用的画面');
      const target = Math.max(0, video.duration - SEEK_BACK_SECONDS);
      const seeked = waitForEvent('seeked');
      video.currentTime = target;
      await seeked;
      canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, FRAME_MIME_TYPE, FRAME_QUALITY));
      if (!blob) throw new Error('无法生成尾帧图片');
      return { mimeType: FRAME_MIME_TYPE, width: canvas.width, height: canvas.height, data: await encodeBlob(blob) };
    } finally {
      // 无论成败都清理：移除尚未触发的监听与定时器，释放视频与画布占用的资源。
      for (const waiter of waiters) waiter.dispose();
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  }

  /** 截取一个结果视频的尾帧并上传；任何一步失败都上报宿主（让等待它的任务失败）。 */
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
          if (extracting.has(resultId)) continue;
          extracting.add(resultId);
          try {
            await extract(resultId);
          } finally {
            extracting.delete(resultId);
          }
        }
      } while (syncAgain);
    } finally {
      syncing = false;
    }
  }

  window.aiTailFrames = { sync };
})();
