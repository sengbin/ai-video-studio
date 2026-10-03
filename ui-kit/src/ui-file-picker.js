// ------------------------------------------------------------------------
// 名称：ui-file-picker.js
// 说明：界面组件库的文件选择控件：选择一个或多个文件，读取为 Base64，显示文件列表并支持上移、下移、移除。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js、ui-button.js、ui-dialog.js（查看原图）、ui-audio-preview.js（音频文件的试听）；类型、数量、大小不符的文件不会加入，原因显示在控件下方；用法见 docs/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  const BYTES_PER_MB = 1024 * 1024;
  const READING_TEXT = '读取中…';
  const VIEWER_WIDTH = 720;
  const VIEWER_HEIGHT = 520;
  const VIEWER_MIN_WIDTH = 320;
  const MIME_BY_EXTENSION = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/mp4'
  };

  /** 取文件名的小写扩展名（含点），没有扩展名返回空串。 */
  function extensionOf(name) {
    const index = name.lastIndexOf('.');
    return index < 0 ? '' : name.slice(index).toLowerCase();
  }

  /** 文件大小的可读文字。 */
  function formatSize(bytes) {
    return bytes < BYTES_PER_MB ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / BYTES_PER_MB).toFixed(2)} MB`;
  }

  /** 把文件读取为不带前缀的 Base64 文本。 */
  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /** 图片文件的 data 地址，用于缩略图与原图。 */
  function toDataUrl(item) {
    return `data:${item.mimeType};base64,${item.data}`;
  }

  /** 在弹出页面中查看图片原图；过大时在页面内滚动。 */
  function openViewer(item) {
    const image = aiUi.h('img', { class: 'ui-file-picker__viewer-image', attrs: { src: toDataUrl(item), alt: item.name } });
    aiUi.openPage({
      title: item.name,
      content: aiUi.h('div', { class: 'ui-file-picker__viewer' }, image),
      width: VIEWER_WIDTH,
      height: VIEWER_HEIGHT,
      minWidth: VIEWER_MIN_WIDTH
    });
  }

  /**
   * 创建文件选择控件。
   * @param {{ accept?: string[], multiple?: boolean, maxFiles?: number, maxFileBytes?: number, buttonText?: string,
   *   emptyText?: string, ariaLabel?: string, disabled?: boolean, preview?: 'image', onChange?: (files: object[]) => void }} [options] 选项：
   *   accept 允许的扩展名（小写，含点，如 ".txt"），为空表示不限；multiple 是否可多选；maxFiles 最多文件数（单选时为 1）；
   *   maxFileBytes 单个文件大小上限；preview 为 'image' 时以缩略图网格显示，点击缩略图查看原图。
   * @returns 控件对象，getValue 返回 [{ name, mimeType, size, data }]，data 为 Base64；另有 whenReady() 在读取完成后 resolve。
   */
  aiUi.filePicker = function (options) {
    const settings = options || {};
    const accept = settings.accept || [];
    const multiple = Boolean(settings.multiple);
    const maxFiles = multiple ? settings.maxFiles || Number.POSITIVE_INFINITY : 1;
    const maxFileBytes = settings.maxFileBytes || Number.POSITIVE_INFINITY;
    const showsThumbnails = settings.preview === 'image';

    let items = [];
    let pending = 0;
    let readyWaiters = [];

    const input = aiUi.h('input', {
      class: 'ui-file-picker__input',
      attrs: { type: 'file', accept: accept.join(','), multiple: multiple ? 'multiple' : undefined, tabindex: '-1', 'aria-hidden': 'true' }
    });
    const chooseButton = aiUi.button({ text: settings.buttonText || (multiple ? '添加文件' : '选择文件'), onClick: () => input.click() });
    const list = aiUi.h('ul', { class: showsThumbnails ? 'ui-file-picker__list ui-file-picker__grid' : 'ui-file-picker__list' });
    const message = aiUi.h('p', { class: 'ui-file-picker__message', hidden: true, attrs: { role: 'status', 'aria-live': 'polite' } });
    const element = aiUi.h(
      'div',
      { class: 'ui-file-picker', attrs: { role: 'group', 'aria-label': settings.ariaLabel } },
      chooseButton.element,
      input,
      list,
      message
    );

    /** 显示或清除控件下方的说明文字。 */
    function showMessage(text, isError) {
      message.textContent = text;
      message.hidden = text === '';
      message.classList.toggle('ui-is-error', Boolean(isError));
    }

    /** 音频文件的试听按钮：播放已选文件的内容，不需要宿主参与。 */
    function renderAudioPreview(item) {
      return aiUi.audioPreview({ iconOnly: true, ariaLabel: `试听：${item.name}`, load: async () => ({ mime: item.mimeType, data: item.data }) }).element;
    }

    /** 重新绘制文件列表。 */
    function renderList() {
      list.textContent = '';
      if (items.length === 0) {
        list.append(aiUi.h('li', { class: 'ui-file-picker__empty', text: settings.emptyText || '尚未选择文件' }));
        return;
      }
      items.forEach((item, index) => {
        const row = showsThumbnails
          ? aiUi.h(
              'li',
              { class: 'ui-file-picker__card' },
              aiUi.h(
                'button',
                {
                  class: 'ui-file-picker__thumb',
                  attrs: { type: 'button', title: item.name, 'aria-label': `查看原图：${item.name}` },
                  on: { click: () => openViewer(item) }
                },
                aiUi.h('img', { class: 'ui-file-picker__thumb-image', attrs: { src: toDataUrl(item), alt: item.name } })
              ),
              aiUi.h('span', { class: 'ui-file-picker__size', text: formatSize(item.size) })
            )
          : aiUi.h(
              'li',
              { class: 'ui-file-picker__item' },
              item.mimeType.startsWith('audio/') ? renderAudioPreview(item) : null,
              aiUi.h('span', { class: 'ui-file-picker__name', text: item.name, attrs: { title: item.name } }),
              aiUi.h('span', { class: 'ui-file-picker__size', text: formatSize(item.size) })
            );
        const actions = aiUi.h('span', { class: 'ui-file-picker__actions' });
        const addAction = (text, label, disabled, handler) => {
          const button = aiUi.button({ text, compact: true, ariaLabel: `${label}：${item.name}`, disabled: disabled || control.isDisabled(), onClick: handler });
          actions.append(button.element);
        };
        if (multiple) {
          // 缩略图横向排列，用“前移”“后移”；文件列表竖向排列，用“上移”“下移”。
          const [backText, forwardText] = showsThumbnails ? ['前移', '后移'] : ['上移', '下移'];
          addAction(backText, backText, index === 0, () => move(index, -1));
          addAction(forwardText, forwardText, index === items.length - 1, () => move(index, 1));
        }
        addAction('移除', '移除', false, () => remove(index));
        row.append(actions);
        list.append(row);
      });
    }

    function move(index, offset) {
      const target = index + offset;
      if (target < 0 || target >= items.length) return;
      [items[index], items[target]] = [items[target], items[index]];
      renderList();
      control.notifyChange();
    }

    function remove(index) {
      items.splice(index, 1);
      showMessage('', false);
      renderList();
      control.notifyChange();
    }

    /** 读取全部完成时唤醒等待者。 */
    function settleWaiters() {
      if (pending > 0) return;
      const waiters = readyWaiters;
      readyWaiters = [];
      waiters.forEach((resolve) => resolve());
    }

    /** 处理用户选中的文件：先筛掉不合格的，再读取合格的。 */
    async function addFiles(files) {
      const problems = [];
      const accepted = [];
      const existing = multiple ? items.length : 0;
      for (const file of files) {
        const extension = extensionOf(file.name);
        if (accept.length > 0 && !accept.includes(extension)) {
          problems.push(`“${file.name}”的类型不受支持，只能选择 ${accept.join('、')}。`);
        } else if (file.size === 0) {
          problems.push(`“${file.name}”是空文件。`);
        } else if (file.size > maxFileBytes) {
          problems.push(`“${file.name}”超过大小上限 ${formatSize(maxFileBytes)}。`);
        } else if (existing + accepted.length >= maxFiles) {
          problems.push(`最多选择 ${maxFiles} 个文件，“${file.name}”未加入。`);
        } else if (multiple && items.some((item) => item.name === file.name && item.size === file.size)) {
          problems.push(`“${file.name}”已经添加过。`);
        } else {
          accepted.push(file);
        }
      }
      showMessage(problems.join('\n'), problems.length > 0);
      if (accepted.length === 0) return;

      pending += accepted.length;
      showMessage(problems.length > 0 ? `${problems.join('\n')}\n${READING_TEXT}` : READING_TEXT, problems.length > 0);
      try {
        const loaded = await Promise.all(
          accepted.map(async (file) => ({
            name: file.name,
            mimeType: file.type || MIME_BY_EXTENSION[extensionOf(file.name)] || 'application/octet-stream',
            size: file.size,
            data: await readAsBase64(file)
          }))
        );
        items = multiple ? [...items, ...loaded] : loaded;
        showMessage(problems.join('\n'), problems.length > 0);
      } catch {
        showMessage('读取文件失败，请重新选择。', true);
      } finally {
        pending -= accepted.length;
        renderList();
        control.notifyChange();
        settleWaiters();
      }
    }

    const control = aiUi.makeControl({
      element,
      focusTarget: chooseButton.element,
      ariaTarget: element,
      labelable: false,
      onChange: settings.onChange,
      getValue: () => items.map((item) => ({ ...item })),
      setValue: (value) => {
        items = Array.isArray(value) ? value.map((item) => ({ ...item })) : [];
        showMessage('', false);
        renderList();
      },
      setDisabled: (disabled) => {
        chooseButton.setDisabled(disabled);
        renderList();
      }
    });
    control.whenReady = () => (pending === 0 ? Promise.resolve() : new Promise((resolve) => readyWaiters.push(resolve)));

    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (files.length > 0) void addFiles(files);
    });
    renderList();
    control.setDisabled(Boolean(settings.disabled));
    return control;
  };
})();
