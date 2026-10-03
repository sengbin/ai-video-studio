// ------------------------------------------------------------------------
// 名称：ui-audio-preview.js
// 说明：界面组件库的试听控件：一个带图标的试听按钮，点击后才读取音频内容并播放，播放时图标变为停止，再点击停止；资产列表、资产版本层与实体绑定页共用。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：依赖 ui-core.js、ui-button.js；音频以 data: 地址播放，页面 CSP 需允许 media-src data:（createPageHtml 已包含）；同一页同一时间只试听一个；用法见 docs/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  /** 按钮的默认文字。 */
  const DEFAULT_TEXT = '试听';
  const DEFAULT_STOP_TEXT = '停止';
  const ICON_PLAY = 'play';
  const ICON_STOP = 'stop';

  /** 正在播放的那个试听控件的停止函数；开始新的试听前先停掉它。 */
  let stopActive = null;

  /**
   * 创建试听控件。
   * @param {{ load: () => Promise<{ mime: string, data: string }|undefined>, text?: string, stopText?: string,
   *   ariaLabel?: string, iconOnly?: boolean, compact?: boolean }} options 选项：
   *   load 读取音频内容（data 为不带前缀的 Base64），读取失败时由调用方自己提示原因并返回 undefined，控件保持可再次尝试；
   *   text 空闲时的按钮文字，默认“试听”；stopText 播放时的按钮文字，默认“停止”；
   *   ariaLabel 空闲时的无障碍名称，同一页有多个试听按钮时用来区分，播放时自动变为“停止”加这个名称；
   *   iconOnly 只显示图标；compact 紧凑尺寸（默认开启，传 false 使用普通尺寸）。
   * @returns {{ element: HTMLElement, button: ReturnType<typeof aiUi.button>, stop: () => void, isPlaying: () => boolean }}
   *   element 为根元素；button 为试听按钮的控件对象。点击读取内容并播放，播放时再点击或播完后回到空闲；已读取后再试听不重复读取。
   */
  aiUi.audioPreview = function (options) {
    const settings = options || {};
    const text = settings.text || DEFAULT_TEXT;
    const stopText = settings.stopText || DEFAULT_STOP_TEXT;
    const idleLabel = settings.ariaLabel || text;
    const playingLabel = settings.ariaLabel ? `停止${settings.ariaLabel}` : stopText;
    /** 读取成功后创建的音频元素（不显示）；尚未读取时为 null。 */
    let player = null;
    let playing = false;

    const button = aiUi.button({
      text,
      icon: ICON_PLAY,
      iconOnly: settings.iconOnly,
      compact: settings.compact !== false,
      ariaLabel: idleLabel,
      onClick: () => (playing ? stop() : void start())
    });
    const element = aiUi.h('span', { class: 'ui-audio-preview' }, button.element);

    /** 同步按钮的图标、文字与无障碍名称。 */
    function render() {
      button.setIcon(playing ? ICON_STOP : ICON_PLAY);
      button.setText(playing ? stopText : text);
      button.setAriaLabel(playing ? playingLabel : idleLabel);
      button.element.classList.toggle('ui-audio-preview__button--playing', playing);
    }

    /** 回到空闲状态；播放结束、出错、被暂停或元素从页面移除（浏览器会暂停它）时都会走到这里。 */
    function setIdle() {
      if (!playing) return;
      playing = false;
      if (stopActive === stop) stopActive = null;
      render();
    }

    /** 停止播放并回到开头。 */
    function stop() {
      if (player !== null) {
        player.pause();
        player.currentTime = 0;
      }
      setIdle();
    }

    /** 首次读取并创建音频元素；读取期间禁用按钮，避免重复读取。失败时返回 false。 */
    async function ensurePlayer() {
      if (player !== null) return true;
      button.setDisabled(true);
      let audio;
      try {
        audio = await settings.load();
      } finally {
        button.setDisabled(false);
      }
      if (audio === undefined) return false;
      player = aiUi.h('audio', { attrs: { src: `data:${audio.mime};base64,${audio.data}` }, hidden: true });
      player.addEventListener('ended', setIdle);
      player.addEventListener('pause', setIdle);
      player.addEventListener('error', setIdle);
      element.append(player);
      return true;
    }

    /** 开始试听：先停掉页面上其他正在试听的，再从头播放。 */
    async function start() {
      if (!(await ensurePlayer())) return;
      if (stopActive !== null) stopActive();
      player.currentTime = 0;
      playing = true;
      stopActive = stop;
      render();
      // 浏览器的自动播放策略可能拒绝播放，此时回到空闲，用户可再点一次。
      try {
        await player.play();
      } catch {
        setIdle();
      }
    }

    return { element, button, stop, isPlaying: () => playing };
  };
})();