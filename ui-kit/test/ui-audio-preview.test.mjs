// ------------------------------------------------------------------------
// 名称：ui-audio-preview.test.mjs
// 说明：界面组件库试听控件的 DOM 测试：点击才读取音频、读取期间禁用、播放时按钮变为停止、再点击停止、播完自动恢复、读取失败可重试、同时只试听一个。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 jsdom；jsdom 没有媒体播放能力，这里替换 play、pause，并按浏览器的行为触发 pause 事件。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createUiEnvironment, fire } from './ui-environment.mjs';

let env;

/** 每个用例使用全新的页面，并让音频元素的 play、pause 只做计数与事件触发。 */
function setup() {
  env = createUiEnvironment();
  const played = { count: 0, rejectNext: false };
  const proto = env.window.HTMLMediaElement.prototype;
  proto.play = function () {
    played.count += 1;
    if (played.rejectNext) {
      played.rejectNext = false;
      return Promise.reject(new Error('NotAllowedError'));
    }
    return Promise.resolve();
  };
  proto.pause = function () {
    this.dispatchEvent(new env.window.Event('pause'));
  };
  return { ui: env.aiUi, doc: env.document, played };
}

afterEach(() => env?.close());

/** 等待已排队的异步任务执行完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 按钮上当前显示的图标形状路径，用来区分播放与停止图标。 */
const iconPath = (preview) => preview.button.element.querySelector('path').getAttribute('d');

const AUDIO = { mime: 'audio/wav', data: 'UklGRg==' };

test('试听：点击前不读取音频，显示播放图标；点击后读取并播放，按钮变为停止', async () => {
  const { ui, doc, played } = setup();
  let loads = 0;
  const preview = ui.audioPreview({
    ariaLabel: '试听音色参考：老陈',
    load: async () => {
      loads += 1;
      return AUDIO;
    }
  });
  doc.body.append(preview.element);
  const playPath = iconPath(preview);

  assert.equal(loads, 0, '点击前不读取音频');
  assert.equal(preview.element.querySelector('audio'), null);
  assert.equal(preview.button.element.textContent.trim(), '试听');
  assert.equal(preview.button.element.getAttribute('aria-label'), '试听音色参考：老陈');
  assert.equal(preview.isPlaying(), false);

  fire(env, preview.button.element, 'click');
  await flush();

  const audio = preview.element.querySelector('audio');
  assert.equal(loads, 1);
  assert.ok(audio, '读取成功后创建音频元素');
  assert.equal(audio.getAttribute('src'), 'data:audio/wav;base64,UklGRg==');
  assert.equal(audio.hasAttribute('controls'), false, '不显示播放器控件');
  assert.equal(audio.hidden, true);
  assert.equal(played.count, 1);
  assert.equal(preview.isPlaying(), true);
  assert.equal(preview.button.element.textContent.trim(), '停止');
  assert.equal(preview.button.element.getAttribute('aria-label'), '停止试听音色参考：老陈');
  assert.notEqual(iconPath(preview), playPath, '播放时换成停止图标');
  assert.equal(preview.button.isDisabled(), false, '读取完成后按钮恢复可用');
});

test('试听：播放时再点击停止并回到播放图标，之后再试听不重复读取', async () => {
  const { ui, doc, played } = setup();
  let loads = 0;
  const preview = ui.audioPreview({
    load: async () => {
      loads += 1;
      return AUDIO;
    }
  });
  doc.body.append(preview.element);
  const playPath = iconPath(preview);

  fire(env, preview.button.element, 'click');
  await flush();
  const audio = preview.element.querySelector('audio');
  audio.currentTime = 3;

  fire(env, preview.button.element, 'click');
  assert.equal(preview.isPlaying(), false);
  assert.equal(audio.currentTime, 0, '停止后回到开头');
  assert.equal(preview.button.element.textContent.trim(), '试听');
  assert.equal(iconPath(preview), playPath);

  fire(env, preview.button.element, 'click');
  await flush();
  assert.equal(loads, 1, '已读取后不再读取');
  assert.equal(preview.element.querySelectorAll('audio').length, 1);
  assert.equal(played.count, 2);
  assert.equal(preview.isPlaying(), true);
});

test('试听：播放结束后自动回到试听状态；纯图标按钮的无障碍名称随状态切换', async () => {
  const { ui, doc } = setup();
  const preview = ui.audioPreview({ iconOnly: true, ariaLabel: '试听：雨声', load: async () => AUDIO });
  doc.body.append(preview.element);

  assert.equal(preview.button.element.textContent.trim(), '', '纯图标按钮不显示文字');
  fire(env, preview.button.element, 'click');
  await flush();
  assert.equal(preview.button.element.getAttribute('aria-label'), '停止试听：雨声');

  preview.element.querySelector('audio').dispatchEvent(new env.window.Event('ended'));
  assert.equal(preview.isPlaying(), false);
  assert.equal(preview.button.element.getAttribute('aria-label'), '试听：雨声');
});

test('试听：读取期间按钮禁用，不会重复读取', async () => {
  const { ui, doc } = setup();
  let loads = 0;
  let finish;
  const preview = ui.audioPreview({
    load: () => {
      loads += 1;
      return new Promise((resolve) => {
        finish = () => resolve(AUDIO);
      });
    }
  });
  doc.body.append(preview.element);

  fire(env, preview.button.element, 'click');
  assert.equal(preview.button.isDisabled(), true, '读取期间禁用，避免重复读取');
  finish();
  await flush();
  assert.equal(preview.button.isDisabled(), false);
  assert.equal(loads, 1);
});

test('试听：读取失败（load 返回 undefined）时没有音频元素，按钮保持试听，可再次尝试', async () => {
  const { ui, doc, played } = setup();
  const results = [undefined, AUDIO];
  const preview = ui.audioPreview({ load: async () => results.shift() });
  doc.body.append(preview.element);

  fire(env, preview.button.element, 'click');
  await flush();
  assert.equal(preview.element.querySelector('audio'), null);
  assert.equal(preview.button.isDisabled(), false);
  assert.equal(preview.isPlaying(), false);
  assert.equal(preview.button.element.textContent.trim(), '试听');
  assert.equal(played.count, 0);

  fire(env, preview.button.element, 'click');
  await flush();
  assert.ok(preview.element.querySelector('audio'), '再次尝试读取成功后创建音频元素');
  assert.equal(preview.isPlaying(), true);
});

test('试听：浏览器拒绝播放时回到试听状态', async () => {
  const { ui, doc, played } = setup();
  const preview = ui.audioPreview({ load: async () => AUDIO });
  doc.body.append(preview.element);
  played.rejectNext = true;

  fire(env, preview.button.element, 'click');
  await flush();
  assert.equal(preview.isPlaying(), false);
  assert.equal(preview.button.element.textContent.trim(), '试听');
});

test('试听：同一页开始新的试听时，上一个自动停止', async () => {
  const { ui, doc } = setup();
  const first = ui.audioPreview({ load: async () => AUDIO });
  const second = ui.audioPreview({ load: async () => AUDIO });
  doc.body.append(first.element, second.element);

  fire(env, first.button.element, 'click');
  await flush();
  assert.equal(first.isPlaying(), true);

  fire(env, second.button.element, 'click');
  await flush();
  assert.equal(first.isPlaying(), false, '上一个已停止');
  assert.equal(first.button.element.textContent.trim(), '试听');
  assert.equal(second.isPlaying(), true);
});

test('试听：按钮文字可自定义，默认是“试听”“停止”', async () => {
  const { ui, doc } = setup();
  assert.equal(ui.audioPreview({ load: async () => undefined, text: '听一下' }).button.element.textContent.trim(), '听一下');

  const preview = ui.audioPreview({ load: async () => AUDIO, text: '听一下', stopText: '别放了' });
  doc.body.append(preview.element);
  fire(env, preview.button.element, 'click');
  await flush();
  assert.equal(preview.button.element.textContent.trim(), '别放了');
});