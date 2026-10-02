// ------------------------------------------------------------------------
// 名称：asset-versions.js
// 说明：资产版本弹出层（P8）：查看某个资产的图片、音频生成版本，勾选图片后采用为资产的参考文件，删除、取消、重试版本，并补生成缩略图。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求名称与 src/app/pages/asset-list-handlers.ts 一致；依赖 asset-generate.js（aiAssetGenerate）与 form/form-runtime.js（aiForm）；缩略图在这里用 canvas 生成并回传，宿主不引入图像库；对外是 window.aiAssetVersions 的 open、refresh、viewImage（弹出页查看原图，列表预览也用）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_VERSIONS = 'assets.versions';
  const REQUEST_VERSION = 'assets.version';
  const REQUEST_FILE_DATA = 'assets.fileData';
  const REQUEST_SAVE_THUMBNAILS = 'assets.saveThumbnails';
  const REQUEST_ADOPT = 'assets.adopt';
  const REQUEST_DELETE_VERSION = 'assets.deleteVersion';
  const REQUEST_RETRY_VERSION = 'assets.retryVersion';
  const FORM_PROMPT = 'asset.prompt';

  const THUMBNAIL_MAX_SIDE = 256;
  const THUMBNAIL_QUALITY = 0.82;
  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const STATUS_LABELS = { queued: '排队中', running: '生成中', succeeded: '已生成', failed: '失败', canceled: '已取消' };
  const LANGUAGE_LABELS = { zh: '中文', en: '英文' };

  /** 当前打开的版本层；没有打开时为 null。 */
  let session = null;

  /** 取错误载荷中的说明文字。 */
  function errorText(error) {
    const fields = error && error.fieldErrors ? Object.values(error.fieldErrors) : [];
    return fields.length > 0 ? fields.join('\n') : (error && error.message) || GENERIC_ERROR_TEXT;
  }

  /** 在提示区显示文字；空串表示清除。 */
  function showMessage(text, isError) {
    session.message.textContent = text;
    session.message.className = isError ? 'asset-ver__message status-error' : 'asset-ver__message status-success';
    session.message.hidden = text === '';
  }

  /** 发起请求；失败时在提示区显示原因并返回 undefined。 */
  async function request(name, payload) {
    try {
      return await window.hostBridge.request(name, payload);
    } catch (error) {
      if (session) showMessage(errorText(error), true);
      return undefined;
    }
  }

  /** 版本下拉里一项的文字。 */
  function versionLabel(version) {
    return `v${version.version} · ${version.isAdopted ? '已采用' : STATUS_LABELS[version.status]}`;
  }

  /** 加载图片，用 canvas 缩小为 JPEG；返回宽高与缩略图内容。 */
  function makeThumbnail(file) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        const scale = Math.min(1, THUMBNAIL_MAX_SIDE / Math.max(width, height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY);
        resolve({ width, height, thumbnail: { mimeType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) } });
      };
      image.onerror = () => reject(new Error('无法读取结果图片。'));
      image.src = `data:${file.mime};base64,${file.data}`;
    });
  }

  /** 为缺少缩略图的结果补生成缩略图并回传；每个版本只尝试一次，失败不影响查看。 */
  async function fillThumbnails(detail) {
    const { version, files, missingThumbnails } = detail;
    if (missingThumbnails.length === 0 || session.thumbnailTried.has(version.id)) return;
    session.thumbnailTried.add(version.id);
    const items = [];
    for (const sortOrder of missingThumbnails) {
      const entry = files.find((file) => file.sortOrder === sortOrder);
      if (!entry) continue;
      try {
        const file = await window.hostBridge.request(REQUEST_FILE_DATA, { fileId: entry.id });
        const made = await makeThumbnail(file);
        items.push({ sortOrder, width: made.width, height: made.height, thumbnail: made.thumbnail });
      } catch {
        return;
      }
    }
    if (items.length > 0) await request(REQUEST_SAVE_THUMBNAILS, { versionId: version.id, items });
  }

  /** 弹出页查看一张图片的原图。 */
  function viewImage(title, data) {
    const image = aiUi.h('img', { class: 'asset-ver__original', attrs: { src: `data:${data.mime};base64,${data.data}`, alt: title } });
    aiUi.openPage({ title, content: aiUi.h('div', { class: 'asset-ver__viewer' }, image), width: 640, height: 520, minWidth: 320, minHeight: 240, buttons: [{ id: 'close', text: '关闭', isCancel: true }] });
  }

  /** 查看一张结果图片的原图。 */
  async function viewOriginal(file, title) {
    const data = await request(REQUEST_FILE_DATA, { fileId: file.id });
    if (data) viewImage(title, data);
  }

  /** 试听音频：点击后才读取音频内容并播放。 */
  async function playAudio(file, slot, button) {
    button.setDisabled(true);
    const data = await request(REQUEST_FILE_DATA, { fileId: file.id });
    button.setDisabled(false);
    if (!data) return;
    slot.textContent = '';
    const player = aiUi.h('audio', { attrs: { controls: 'controls', src: `data:${data.mime};base64,${data.data}` } });
    slot.append(player);
    void player.play().catch(() => undefined);
  }

  /** 图片版本的缩略图网格：点击缩略图看原图，复选框决定采用哪几张。 */
  function renderImages(detail) {
    const grid = aiUi.h('div', { class: 'asset-ver__grid' });
    for (const file of detail.files) {
      const checkbox = aiUi.checkbox({
        label: file.isAdopted ? '采用（已采用）' : '采用',
        checked: session.selectedFileIds.has(file.id),
        onChange: (value) => {
          if (value) session.selectedFileIds.add(file.id);
          else session.selectedFileIds.delete(file.id);
          updateButtons();
        }
      });
      const thumb = file.thumbnail
        ? aiUi.h(
            'button',
            { class: 'asset-ver__thumb', attrs: { type: 'button', 'aria-label': `查看原图：${detail.version.version}-${file.sortOrder + 1}` }, on: { click: () => void viewOriginal(file, `v${detail.version.version} · 第 ${file.sortOrder + 1} 张`) } },
            aiUi.h('img', { class: 'asset-ver__thumb-image', attrs: { src: `data:${file.thumbnail.mime};base64,${file.thumbnail.data}`, alt: `第 ${file.sortOrder + 1} 张` } })
          )
        : aiUi.h('div', { class: 'asset-ver__thumb asset-ver__thumb--empty', text: '缩略图生成中…' });
      grid.append(
        aiUi.h(
          'div',
          { class: 'asset-ver__item' },
          thumb,
          aiUi.h('span', { class: 'description', text: file.width && file.height ? `${file.width}×${file.height}` : '' }),
          checkbox.element
        )
      );
    }
    return grid;
  }

  /** 音频版本的信息卡：时长、格式与试听。 */
  function renderAudio(detail) {
    const [file] = detail.files;
    if (!file) return aiUi.h('p', { class: 'description', text: '没有结果文件。' });
    const slot = aiUi.h('div', { class: 'asset-ver__player' });
    const button = aiUi.button({ text: '试听', compact: true, ariaLabel: '试听音频', onClick: () => void playAudio(file, slot, button) });
    const duration = file.durationSeconds === null ? '' : `${Number(file.durationSeconds.toFixed(1))} 秒 · `;
    return aiUi.h(
      'div',
      { class: 'asset-ver__audio' },
      aiUi.h('span', { text: `${duration}${file.mime.replace('audio/', '').toUpperCase()}${file.isAdopted ? ' · 已采用' : ''}` }),
      button.element,
      slot
    );
  }

  /** 生成参数与时间的信息区。 */
  function renderInfo(detail) {
    const { version } = detail;
    const lines = [`模型：${version.modelName}`, `提示词语言：${LANGUAGE_LABELS[version.promptLanguage] || version.promptLanguage}`];
    if (session.list.kind !== 'audio') {
      lines.push(`数量：${version.count}`);
      if (version.aspectRatio) lines.push(`画幅：${version.aspectRatio}`);
      if (version.resolution) lines.push(`分辨率：${version.resolution}`);
    } else if (version.language) {
      lines.push(`语言：${LANGUAGE_LABELS[version.language] || version.language}`);
    }
    lines.push(`提交于：${new Date(version.createdAt).toLocaleString('zh-CN')}`);
    if (version.finishedAt) lines.push(`结束于：${new Date(version.finishedAt).toLocaleString('zh-CN')}`);
    if (version.attempt > 1) lines.push(`第 ${version.attempt} 次尝试`);
    const prompts = aiUi.h(
      'details',
      { class: 'asset-ver__prompts' },
      aiUi.h('summary', { text: '生成时使用的提示词' }),
      aiUi.h('p', { class: 'asset-ver__prompt', text: `中文：${detail.promptZh || '（空）'}` }),
      aiUi.h('p', { class: 'asset-ver__prompt', text: `英文：${detail.promptEn || '（空）'}` })
    );
    return aiUi.h('div', { class: 'asset-ver__info' }, aiUi.h('p', { class: 'description', text: lines.join(' · ') }), prompts);
  }

  /** 当前资产参考文件的来源说明。 */
  function describeCurrent(list) {
    if (list.adoptedVersionId !== null) {
      const adopted = list.versions.find((item) => item.id === list.adoptedVersionId);
      return `当前采用：v${adopted ? adopted.version : '?'}`;
    }
    return list.hasManualFiles ? '当前参考文件：手动上传' : '当前还没有参考文件';
  }

  /** 提示条：有改动未生成、提示词需更新、生成中与失败原因。 */
  function renderNotices(detail) {
    const notices = [];
    const { list } = session;
    if (list.hasUngeneratedChanges) {
      notices.push(aiUi.h('p', { class: 'status-warning', text: '资产设定或提示词在最新版本之后修改过，当前版本基于较早的内容。' }));
    }
    if (list.isPromptOutdated) {
      notices.push(aiUi.h('p', { class: 'status-warning', text: '表单字段在提示词之后改过，提示词可能需要更新（可在列表里重新生成提示词）。' }));
    }
    const { version } = detail;
    if (version.status === 'queued' || version.status === 'running') {
      notices.push(aiUi.h('p', { class: 'description', text: '正在生成，通常需要几十秒到几分钟，完成后会自动显示。' }));
    }
    if (version.error) {
      notices.push(
        aiUi.h('p', { class: 'status-error', text: `失败：${version.error.label}` }),
        aiUi.h('p', { class: 'description', text: version.error.message + (version.error.code ? `（${version.error.code}）` : '') }),
        aiUi.h('p', { class: 'description', text: version.error.hint })
      );
    }
    return notices;
  }

  /** 按当前版本与勾选状态刷新按钮的可用性。 */
  function updateButtons() {
    if (!session || !session.list) return;
    const { list } = session;
    const buttons = session.buttons;
    buttons.generate.setDisabled(!list.availability.available);
    buttons.generate.element.title = list.availability.reason || '';
    // 提示词或图片生成中不能编辑提示词
    const busy = list.isPromptRunning || list.versions.some((item) => item.status === 'queued' || item.status === 'running');
    buttons.editPrompt.setDisabled(busy);
    if (!session.detail) {
      buttons.adopt.setDisabled(true);
      buttons.remove.setDisabled(true);
      buttons.retry.element.hidden = true;
      return;
    }
    const { version, missingThumbnails } = session.detail;
    const active = version.status === 'queued' || version.status === 'running';
    const ready = version.status === 'succeeded' && missingThumbnails.length === 0 && session.selectedFileIds.size > 0;
    buttons.adopt.setDisabled(!ready);
    buttons.remove.setDisabled(active || version.isAdopted);
    buttons.retry.element.hidden = version.status !== 'failed' && version.status !== 'canceled';
  }

  /** 重绘版本下拉与主体内容。 */
  function renderBody() {
    const { list, detail } = session;
    session.summary.textContent = describeCurrent(list);
    session.buttons.generate.setText(list.kind === 'audio' ? '生成音频' : '生成图片');
    session.versionSlot.textContent = '';
    if (list.versions.length > 0) {
      const select = aiUi.select({
        options: list.versions.map((item) => ({ value: String(item.id), label: versionLabel(item) })),
        value: String(session.versionId),
        allowEmpty: false,
        ariaLabel: '版本',
        onChange: (value) => {
          session.versionId = Number(value);
          void loadDetail();
        }
      });
      session.versionSlot.append(select.element);
    }

    session.body.textContent = '';
    if (list.versions.length === 0) {
      session.body.append(aiUi.h('p', { class: 'description', text: `还没有生成过${list.kind === 'audio' ? '音频' : '图片'}。点“生成${list.kind === 'audio' ? '音频' : '图片'}”开始。` }));
      return;
    }
    if (!detail) {
      session.body.append(aiUi.h('p', { class: 'description', text: '加载中…' }));
      return;
    }
    session.body.append(
      ...renderNotices(detail),
      detail.version.status === 'succeeded' ? (list.kind === 'audio' ? renderAudio(detail) : renderImages(detail)) : null,
      renderInfo(detail)
    );
  }

  /** 读取版本列表；保持选中的版本，没有选中或已被删除时选最新的。 */
  async function loadList(preferLatest) {
    const current = session;
    let list;
    try {
      list = await window.hostBridge.request(REQUEST_VERSIONS, { assetId: current.assetId });
    } catch (error) {
      if (session !== current) return;
      // 资产已被删除（或随项目一起删除）时自动关闭。
      if (error && error.kind === 'not-found') current.page.close('api');
      else showMessage(errorText(error), true);
      return;
    }
    if (session !== current) return;
    current.list = list;
    const exists = list.versions.some((item) => item.id === current.versionId);
    if (preferLatest || !exists) current.versionId = list.versions.length > 0 ? list.versions[0].id : null;
    if (current.versionId === null) {
      current.detail = null;
      renderBody();
      updateButtons();
      return;
    }
    await loadDetail();
  }

  /** 读取选中版本的详情；缺缩略图时补生成。 */
  async function loadDetail() {
    const current = session;
    const versionId = current.versionId;
    const detail = await request(REQUEST_VERSION, { versionId });
    if (!detail || session !== current || current.versionId !== versionId) return;
    if (!current.detail || current.detail.version.id !== versionId) {
      // 切换到另一个版本：默认勾选全部结果，已采用过的只勾选采用的那几张。
      const adoptedIds = detail.files.filter((file) => file.isAdopted).map((file) => file.id);
      const initial = adoptedIds.length > 0 ? adoptedIds : detail.files.map((file) => file.id);
      current.selectedFileIds = new Set(initial.slice(0, 10));
    }
    current.detail = detail;
    renderBody();
    updateButtons();
    await fillThumbnails(detail);
  }

  /** 采用所选图片（音频）：先确认会替换现有参考文件。 */
  async function adoptSelected() {
    const { detail, list } = session;
    const used = detail.usedByEpisodes > 0 ? `这个资产已被 ${detail.usedByEpisodes} 集使用，之后提交的视频将使用新文件，已提交的不受影响。` : '';
    const replacing = list.hasManualFiles ? '手动上传的参考文件会被替换。' : list.adoptedVersionId !== null ? '原来采用的文件会被替换。' : '';
    const noun = list.kind === 'audio' ? '音频' : `所选 ${session.selectedFileIds.size} 张图片`;
    const confirmed = await aiUi.confirm({
      title: `采用 v${detail.version.version}`,
      message: `将用${noun}作为资产的参考${list.kind === 'audio' ? '音频' : '图'}。${replacing}${used}`,
      confirmText: '采用',
      cancelText: '取消'
    });
    if (!confirmed || !session) return;
    const result = await request(REQUEST_ADOPT, { versionId: detail.version.id, fileIds: [...session.selectedFileIds] });
    if (result && session) showMessage(`已采用 v${detail.version.version}。`, false);
  }

  /** 删除当前版本：先确认。 */
  async function deleteCurrent() {
    const { version } = session.detail;
    const confirmed = await aiUi.confirm({
      title: `删除 v${version.version}`,
      message: '仅删除这个版本的文件，无法恢复。',
      confirmText: '删除',
      variant: 'danger'
    });
    if (!confirmed || !session) return;
    session.thumbnailTried.delete(version.id);
    if (await request(REQUEST_DELETE_VERSION, { versionId: version.id })) showMessage(`已删除 v${version.version}。`, false);
  }

  /** 重试当前版本（失败或已取消）。 */
  async function retryCurrent() {
    session.thumbnailTried.delete(session.detail.version.id);
    await request(REQUEST_RETRY_VERSION, { versionId: session.detail.version.id });
  }

  /** 生成新版本：弹出生成对话框，提交后选中新版本。 */
  function generateNew() {
    const { assetId, name, list } = session;
    void window.aiAssetGenerate.open({ id: assetId, name, kind: list.kind }, () => {
      if (session) void loadList(true);
    });
  }

  /** 弹出提示词表单修改提示词。 */
  function editPrompt() {
    void window.aiForm.open({ form: FORM_PROMPT, params: { assetId: session.assetId } });
  }

  /**
   * 打开资产的版本层；已打开时不重复打开。
   * @param {{ id: number, name: string }} asset 资产。
   */
  function open(asset) {
    if (session) return;
    const message = aiUi.h('p', { class: 'asset-ver__message', hidden: true, attrs: { role: 'status' } });
    const summary = aiUi.h('span', { class: 'description' });
    const versionSlot = aiUi.h('div', { class: 'asset-ver__select' });
    const body = aiUi.h('div', { class: 'asset-ver__body' });
    const buttons = {
      adopt: aiUi.button({ text: '采用此版本', variant: 'primary', compact: true, disabled: true, onClick: () => void adoptSelected() }),
      remove: aiUi.button({ text: '删除此版本', compact: true, disabled: true, onClick: () => void deleteCurrent() }),
      retry: aiUi.button({ text: '重试', compact: true, onClick: () => void retryCurrent() }),
      generate: aiUi.button({ text: '生成', compact: true, onClick: generateNew }),
      editPrompt: aiUi.button({ text: '编辑提示词', compact: true, onClick: editPrompt })
    };
    buttons.retry.element.hidden = true;
    const bar = aiUi.h(
      'div',
      { class: 'asset-ver__bar' },
      versionSlot,
      summary,
      aiUi.h('div', { class: 'asset-ver__actions' }, Object.values(buttons).map((button) => button.element))
    );
    const content = aiUi.h('div', { class: 'asset-ver' }, bar, message, body);
    session = { assetId: asset.id, name: asset.name, page: null, versionId: null, list: null, detail: null, selectedFileIds: new Set(), thumbnailTried: new Set(), message, summary, versionSlot, body, buttons };
    const page = aiUi.openPage({ title: `版本：${asset.name}`, content, width: 760, height: 560, minWidth: 460, minHeight: 320, buttons: [{ id: 'close', text: '关闭', isCancel: true }] });
    session.page = page;
    void page.closed.then(() => {
      session = null;
    });
    void loadList(true);
  }

  /** 数据变化后刷新版本层；资产已被删除时关闭。 */
  async function refresh() {
    if (session) await loadList(false);
  }

  window.aiAssetVersions = { open, refresh, viewImage };
})();
