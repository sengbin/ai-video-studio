// ------------------------------------------------------------------------
// 名称：ui-audio-preview.test.mjs
// 说明：界面组件库试听控件的 DOM 测试：点击才读取音频、读取期间禁用、读取失败不显示播放器、再次点击从头播放。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：使用 jsdom；jsdom 没有媒体播放能力，这里替换 play 并统计调用次数。
// ------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createUiEnvironment, fire } from './ui-environment.mjs';

let env;

/** 每个用例使用全新的页面，并让音频元素的 play 只做计数。 */
function setup() {
  env = createUiEnvironment();
  const played = { count: 0 };
  env.window.HTMLMediaElement.prototype.play = () => {
    played.count += 1;
    return Promise.resolve();
  };
  return { ui: env.aiUi, doc: env.document, played };
}

afterEach(() => env?.close());

/** 等待已排队的异步任务执行完。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('试听：点击前不读取音频也没有播放器，点击后读取并显示带控件的播放器、自动播放', async () => {
  const { ui, doc, played } = setup();
  let loads = 0;
  const preview = ui.audioPreview({
    ariaLabel: '试听音色参考：老陈',
    load: async () => {
      loads += 1;
      return { mime: 'audio/wav', data: 'UklGRg==' };
    }
  });
  doc.body.append(preview.element);

  assert.equal(loads, 0, '点击前不读取音频');
  assert.equal(preview.element.querySelector('audio'), null);
  assert.equal(preview.button.element.textContent.trim(), '试听');
  assert.equal(preview.button.element.getAttribute('aria-label'), '试听音色参考：老陈');

  fire(env, preview.button.element, 'click');
  await flush();

  const audio = preview.element.querySelector('audio');
  assert.equal(loads, 1);
  assert.ok(audio, '读取成功后显示播放器');
  assert.equal(audio.getAttribute('src'), 'data:audio/wav;base64,UklGRg==');
  assert.ok(audio.hasAttribute('controls'));
  assert.equal(played.count, 1);
  assert.equal(preview.button.isDisabled(), false, '读取完成后按钮恢复可用');
});

test('试听：读取期间按钮禁用，已读取后再次点击不重复读取，从头重新播放', async () => {
  const { ui, doc, played } = setup();
  let loads = 0;
  let finish;
  const preview = ui.audioPreview({
    load: () => {
      loads += 1;
      return new Promise((resolve) => {
        finish = () => resolve({ mime: 'audio/mpeg', data: 'AAAA' });
      });
    }
  });
  doc.body.append(preview.element);

  fire(env, preview.button.element, 'click');
  assert.equal(preview.button.isDisabled(), true, '读取期间禁用，避免重复读取');
  finish();
  await flush();
  assert.equal(preview.button.isDisabled(), false);

  const audio = preview.element.querySelector('audio');
  audio.currentTime = 5;
  fire(env, preview.button.element, 'click');
  await flush();

  assert.equal(loads, 1, '已读取后不再读取');
  assert.equal(preview.element.querySelectorAll('audio').length, 1);
  assert.equal(audio.currentTime, 0, '再次点击从头播放');
  assert.equal(played.count, 2);
});

test('试听：读取失败（load 返回 undefined）时不显示播放器，按钮恢复，可再次尝试', async () => {
  const { ui, doc, played } = setup();
  const results = [undefined, { mime: 'audio/wav', data: 'AAAA' }];
  const preview = ui.audioPreview({ load: async () => results.shift() });
  doc.body.append(preview.element);

  fire(env, preview.button.element, 'click');
  await flush();
  assert.equal(preview.element.querySelector('audio'), null);
  assert.equal(preview.button.isDisabled(), false);
  assert.equal(played.count, 0);

  fire(env, preview.button.element, 'click');
  await flush();
  assert.ok(preview.element.querySelector('audio'), '再次尝试读取成功后显示播放器');
});

test('试听：按钮文字可自定义，默认是“试听”', () => {
  const { ui } = setup();
  assert.equal(ui.audioPreview({ load: async () => undefined, text: '听一下' }).button.element.textContent.trim(), '听一下');
});
