// ------------------------------------------------------------------------
// 名称：player.js
// 说明：结果视频的内置播放器：向宿主读取结果视频（Base64），在弹出页里用原生播放控件播放，带声音的结果可用播放控件静音。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：请求名称与 src/app/pages/workbench-handlers.ts 一致；依赖 shared/page-format.js（pageFormat.decodeBase64）；必须先于 workbench.js 加载；对外是 window.aiPlayer.open；视频以 blob 地址播放（页面的内容安全策略允许 media-src blob:），关闭时释放；宿主对读取的视频大小有上限，超过时显示原因，仍可用“打开视频”交给系统播放器。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_VIDEO = 'workbench.resultVideo';
  const GENERIC_ERROR_TEXT = '无法读取这个视频。';
  const PLAYER_WIDTH = 760;
  const PLAYER_HEIGHT = 520;

  /** 取错误载荷中的说明文字。 */
  function errorText(error) {
    const fields = error && error.fieldErrors ? Object.values(error.fieldErrors) : [];
    if (fields.length > 0) return fields.join('\n');
    return (error && error.message) || GENERIC_ERROR_TEXT;
  }

  /**
   * 打开播放器弹出页并开始读取视频；同一时间可以打开多个。
   * @param {{ resultId: number, title: string, hasAudio?: boolean }} options 结果标识、标题与是否带声音。
   */
  function open(options) {
    const status = aiUi.h('p', { class: 'description', text: '正在读取视频…' });
    const video = aiUi.h('video', { class: 'wb-player__video', hidden: true, attrs: { controls: '', preload: 'metadata', playsinline: '' } });
    const note = aiUi.h('p', { class: 'description', text: options.hasAudio ? '这个视频带声音，可用播放控件调节音量或静音。' : '这个视频没有声音。', hidden: true });
    const content = aiUi.h('div', { class: 'wb-player' }, status, video, note);
    let videoUrl = '';
    const page = aiUi.openPage({
      title: options.title,
      content,
      width: PLAYER_WIDTH,
      height: PLAYER_HEIGHT,
      minWidth: 360,
      minHeight: 260,
      buttons: [{ id: 'close', text: '关闭', isCancel: true }]
    });
    void page.closed.then(() => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (videoUrl) URL.revokeObjectURL(videoUrl);
    });

    video.addEventListener('error', () => {
      status.textContent = '视频无法解码播放，可以用“打开视频”交给系统播放器。';
      status.className = 'status-error';
      status.hidden = false;
      video.hidden = true;
    });
    void (async () => {
      try {
        const source = await window.hostBridge.request(REQUEST_VIDEO, { resultId: options.resultId });
        videoUrl = URL.createObjectURL(new Blob([window.pageFormat.decodeBase64(source.data)], { type: source.mimeType }));
        video.src = videoUrl;
        status.hidden = true;
        video.hidden = false;
        note.hidden = false;
      } catch (error) {
        status.textContent = errorText(error);
        status.className = 'status-error';
      }
    })();
  }

  window.aiPlayer = { open };
})();
