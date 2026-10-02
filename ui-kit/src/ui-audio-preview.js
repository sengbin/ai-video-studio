// ------------------------------------------------------------------------
// 名称：ui-audio-preview.js
// 说明：界面组件库的试听控件：一个“试听”按钮，点击后才读取音频内容，并在按钮旁显示播放器、自动播放；资产版本层与实体绑定页共用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：依赖 ui-core.js、ui-button.js；音频以 data: 地址播放，页面 CSP 需允许 media-src data:（createPageHtml 已包含）；用法见 docs/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  /** 按钮的默认文字。 */
  const DEFAULT_TEXT = '试听';

  /**
   * 创建试听控件。
   * @param {{ load: () => Promise<{ mime: string, data: string }|undefined>, text?: string, ariaLabel?: string }} options 选项：
   *   load 读取音频内容（data 为不带前缀的 Base64），读取失败时由调用方自己提示原因并返回 undefined，控件不再显示播放器；
   *   text 按钮文字，默认“试听”；ariaLabel 按钮的无障碍名称，同一页有多个试听按钮时用来区分。
   * @returns {{ element: HTMLElement, button: ReturnType<typeof aiUi.button> }}
   *   element 为根元素；button 为试听按钮的控件对象。首次点击读取内容并显示带控件的播放器，已读取后再次点击从头播放。
   */
  aiUi.audioPreview = function (options) {
    const settings = options || {};
    /** 读取成功后创建的播放器；尚未读取时为 null。 */
    let player = null;

    const button = aiUi.button({
      text: settings.text || DEFAULT_TEXT,
      compact: true,
      ariaLabel: settings.ariaLabel,
      onClick: () => void play()
    });
    const element = aiUi.h('span', { class: 'ui-audio-preview' }, button.element);

    /** 首次点击读取并创建播放器，之后从头播放；读取期间禁用按钮，避免重复读取。 */
    async function play() {
      if (player === null) {
        button.setDisabled(true);
        let audio;
        try {
          audio = await settings.load();
        } finally {
          button.setDisabled(false);
        }
        if (audio === undefined) return;
        player = aiUi.h('audio', { attrs: { controls: 'controls', src: `data:${audio.mime};base64,${audio.data}` } });
        element.append(player);
      } else {
        player.currentTime = 0;
      }
      // 浏览器的自动播放策略可能拒绝播放，此时用户仍可点播放器上的按钮。
      void player.play().catch(() => undefined);
    }

    return { element, button };
  };
})();
