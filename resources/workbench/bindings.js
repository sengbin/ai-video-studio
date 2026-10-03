// ------------------------------------------------------------------------
// 名称：bindings.js
// 说明：实体绑定面板（F9，检查器的“绑定”页签）：按类型分组列出本集的实体，可选择形象资产、设为主资产、解除，角色实体可选择音色参考音频并试听，并支持按名称自动匹配；选择资产仍用弹出页。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求名称与 src/app/pages/binding-handlers.ts 一致；必须先于 workbench.js 加载；对外只有 window.aiBindings.create()，返回面板元素与 setEpisode、refresh。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_VIEW = 'bindings.view';
  const REQUEST_BIND = 'bindings.bind';
  const REQUEST_UNBIND = 'bindings.unbind';
  const REQUEST_SET_PRIMARY = 'bindings.setPrimary';
  const REQUEST_SUGGEST = 'bindings.suggest';
  const REQUEST_VOICE_AUDIO = 'bindings.voiceAudio';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const MAX_SUGGESTION_LINES = 12;
  const PURPOSE_VISUAL = 'visual';
  const PURPOSE_VOICE = 'voice';
  const KIND_LABELS = { character: '角色', scene: '场景', prop: '道具', effect: '特效' };

  /** 当前的绑定面板会话；只有一个。 */
  let session = null;

  /** 取错误载荷中的说明文字：有字段错误时列出各项，否则用错误说明。 */
  function errorText(error) {
    const fields = error && error.fieldErrors ? Object.values(error.fieldErrors) : [];
    if (fields.length > 0) return fields.join('\n');
    return (error && error.message) || GENERIC_ERROR_TEXT;
  }

  /** 在给定的提示区显示文字；空串表示清除。 */
  function setMessage(element, text, isError) {
    element.textContent = text;
    element.className = isError ? 'wb-message status-error' : 'wb-message status-success';
    element.hidden = text === '';
  }

  /** 发起请求；失败时在提示区显示原因并返回 undefined。 */
  async function request(name, payload, messageElement) {
    setMessage(messageElement, '', false);
    try {
      return await window.hostBridge.request(name, payload);
    } catch (error) {
      setMessage(messageElement, errorText(error), true);
      return undefined;
    }
  }

  /** 资产缩略图；音频显示“音频”，没有图显示“无图”。 */
  function renderThumb(item) {
    if (item.thumbnail) {
      return aiUi.h(
        'div',
        { class: 'wb-bind-thumb' },
        aiUi.h('img', { class: 'wb-bind-thumb__image', attrs: { src: `data:${item.thumbnail.mime};base64,${item.thumbnail.data}`, alt: item.assetName || item.name } })
      );
    }
    return aiUi.h('div', { class: 'wb-bind-thumb wb-bind-thumb--empty', text: item.durationSeconds === null ? '无图' : '音频' });
  }

  /** 选择资产的弹出页：可按名称搜索，点“选择”后调用 onPick，返回 true 才关闭。 */
  function openPicker(options) {
    const { title, assets, emptyText, onPick, withPreview } = options;
    const message = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    let keyword = '';
    const pick = async (asset) => {
      if (await onPick(asset, message)) page.close('api');
    };
    const columns = [
      withPreview
        ? { title: '试听', width: 64, render: (asset) => renderVoicePreview({ assetId: asset.id, assetName: asset.name, message }) }
        : { title: '预览', width: 64, render: (asset) => renderThumb({ ...asset, assetName: asset.name }) },
      { title: '名称', minWidth: 160, render: (asset) => aiUi.tableMainCell({ text: asset.name, description: asset.durationSeconds === null ? '' : `${asset.durationSeconds} 秒` }) },
      { title: '操作', type: 'actions', render: (asset) => aiUi.button({ text: '选择', compact: true, variant: 'primary', ariaLabel: `选择：${asset.name}`, onClick: () => void pick(asset) }).element }
    ];
    const table = aiUi.table({ columns, rows: assets, ariaLabel: '可选资产' });
    const empty = aiUi.h('p', { class: 'description', text: emptyText, hidden: assets.length > 0 });
    const search = aiUi.textInput({
      type: 'search',
      placeholder: '搜索资产名称',
      ariaLabel: '搜索资产名称',
      onChange: (value) => {
        keyword = value.trim();
        table.setRows(assets.filter((asset) => asset.name.includes(keyword)));
      }
    });
    const content = aiUi.h('div', { class: 'wb-bind-picker' }, aiUi.h('div', { class: 'wb-bind-picker__search' }, search.element), message, empty, assets.length > 0 ? table.element : null);
    const page = aiUi.openPage({ title, content, width: 520, height: 460, minWidth: 360, minHeight: 280, buttons: [{ id: 'cancel', text: '取消', isCancel: true }] });
  }

  /** 一条绑定：缩略图、名称、主资产标记、设为主资产与解除；音色参考带“试听”。 */
  function renderItem(item, siblingCount, withPreview) {
    const buttons = [];
    if (siblingCount > 1 && !item.isPrimary) {
      buttons.push(aiUi.button({ text: '设为主资产', compact: true, ariaLabel: `把${item.assetName}设为主资产`, onClick: () => void changeBinding(REQUEST_SET_PRIMARY, { id: item.id }) }).element);
    }
    buttons.push(aiUi.button({ text: '解除', compact: true, ariaLabel: `解除绑定：${item.assetName}`, onClick: () => void changeBinding(REQUEST_UNBIND, { id: item.id }) }).element);
    return aiUi.h(
      'div',
      { class: 'wb-bind-item' },
      renderThumb(item),
      aiUi.h('span', { class: 'wb-bind-item__name', text: item.assetName, attrs: { title: item.assetName } }),
      siblingCount > 1 && item.isPrimary ? aiUi.chip({ text: '主资产' }) : null,
      item.durationSeconds === null ? null : aiUi.h('span', { class: 'description', text: `${item.durationSeconds} 秒` }),
      withPreview ? renderVoicePreview(item) : null,
      buttons
    );
  }

  /** 音色参考的试听控件：点击后才向宿主读取音频内容；失败时在提示区显示原因，默认是面板提示区，选择页传自己的 message。 */
  function renderVoicePreview(item) {
    return aiUi.audioPreview({
      ariaLabel: `试听音色参考：${item.assetName}`,
      iconOnly: Boolean(item.message),
      load: () => request(REQUEST_VOICE_AUDIO, { assetId: item.assetId }, item.message || session.message)
    }).element;
  }

  /** 形象资产单元格：已绑定的资产与“选择资产”“新建资产”。 */
  function renderVisualCell(entity) {
    return aiUi.h(
      'div',
      { class: 'wb-bind-cell' },
      entity.visual.length === 0 ? aiUi.h('span', { class: 'status-warning', text: '未绑定' }) : entity.visual.map((item) => renderItem(item, entity.visual.length)),
      aiUi.h(
        'div',
        { class: 'wb-bind-cell__actions' },
        aiUi.button({ text: entity.visual.length === 0 ? '选择资产' : '再选一个', compact: true, ariaLabel: `为${entity.name}选择资产`, onClick: () => pickVisual(entity) }).element,
        aiUi.button({ text: '新建资产', compact: true, ariaLabel: `按${entity.name}的设定新建${entity.kindLabel}资产`, onClick: () => void createAsset(entity) }).element
      )
    );
  }

  /** 按实体设定预填新建资产，保存后自动绑定为该实体的形象。 */
  async function createAsset(entity) {
    if (!session) return;
    const saved = await window.aiForm.open({ form: 'asset.create', params: { episodeId: session.episodeId, entityId: entity.entityId } });
    if (saved) await refresh();
  }

  /** 音色参考单元格：只有角色有；一个实体使用一个音色，更换时替换原来的。 */
  function renderVoiceCell(entity) {
    if (entity.kind !== 'character') return null;
    return aiUi.h(
      'div',
      { class: 'wb-bind-cell' },
      entity.voice.length === 0 ? aiUi.h('span', { class: 'description', text: '未指定（只使用设定里的文字音色）' }) : entity.voice.map((item) => renderItem(item, 1, true)),
      aiUi.button({ text: entity.voice.length === 0 ? '选择音色' : '更换音色', compact: true, ariaLabel: `为${entity.name}选择音色参考`, onClick: () => pickVoice(entity) }).element
    );
  }

  /** 一个实体：名称与类型、形象资产、角色的音色参考。 */
  function renderEntity(entity) {
    return aiUi.h(
      'div',
      { class: 'wb-bind-entity' },
      aiUi.h('div', { class: 'wb-bind-entity__head' }, aiUi.h('strong', { text: entity.name }), aiUi.chip({ text: entity.kindLabel })),
      renderVisualCell(entity),
      entity.kind === 'character'
        ? aiUi.h('div', { class: 'wb-bind-entity__voice' }, aiUi.h('div', { class: 'description', text: '音色参考' }), renderVoiceCell(entity))
        : null
    );
  }

  /** 按类型分组（角色、场景、道具、特效）列出实体，组标题带数量。 */
  function renderEntities(entities) {
    return Object.keys(KIND_LABELS)
      .map((kind) => ({ kind, items: entities.filter((entity) => entity.kind === kind) }))
      .filter((group) => group.items.length > 0)
      .map((group) =>
        aiUi.h(
          'section',
          { class: 'wb-bind-group', attrs: { 'aria-label': KIND_LABELS[group.kind] } },
          aiUi.h('h3', { class: 'wb-bind-group__title', text: `${KIND_LABELS[group.kind]}（${group.items.length}）` }),
          group.items.map(renderEntity)
        )
      );
  }

  /** 解除、设为主资产这类单次请求，完成后重新读取。 */
  async function changeBinding(name, payload) {
    if (!session) return;
    if (await request(name, payload, session.message)) await refresh();
  }

  /** 为实体选择形象资产：只列同类型、尚未绑定到该实体的资产。 */
  function pickVisual(entity) {
    const bound = new Set(entity.visual.map((item) => item.assetId));
    openPicker({
      title: `选择${entity.kindLabel}资产：${entity.name}`,
      assets: session.view.visualAssets[entity.kind].filter((asset) => !bound.has(asset.id)),
      emptyText: `本项目没有可绑定的${KIND_LABELS[entity.kind]}资产。请先到侧栏“资产”里添加，或已全部绑定。`,
      onPick: async (asset, message) => {
        const result = await request(REQUEST_BIND, { episodeId: session.episodeId, entityId: entity.entityId, assetId: asset.id, purpose: PURPOSE_VISUAL }, message);
        if (result) await refresh();
        return Boolean(result);
      }
    });
  }

  /** 为角色选择音色参考：新的先绑定并设为主，再解除原来的，失败时原来的保持不变。 */
  function pickVoice(entity) {
    openPicker({
      title: `选择音色参考：${entity.name}`,
      withPreview: true,
      assets: session.view.voiceAssets.filter((asset) => !entity.voice.some((item) => item.assetId === asset.id)),
      emptyText: '本项目没有可用的音色参考音频。请先到侧栏“资产 > 音频”里添加类型为“音色参考”的音频。',
      onPick: async (asset, message) => {
        const bound = await request(REQUEST_BIND, { episodeId: session.episodeId, entityId: entity.entityId, assetId: asset.id, purpose: PURPOSE_VOICE }, message);
        if (!bound) return false;
        if (entity.voice.length > 0) {
          if (!(await request(REQUEST_SET_PRIMARY, { id: bound.id }, message))) return false;
          for (const old of entity.voice) {
            if (!(await request(REQUEST_UNBIND, { id: old.id }, message))) return false;
          }
        }
        await refresh();
        return true;
      }
    });
  }

  /** 按名称自动匹配：先列出将建立的绑定，确认后逐条写入。 */
  async function autoMatch() {
    if (!session) return;
    const { message, episodeId } = session;
    const data = await request(REQUEST_SUGGEST, { episodeId }, message);
    if (!data) return;
    if (data.suggestions.length === 0) {
      await aiUi.alert({ title: '按名称自动匹配', message: '没有可以建立的绑定。只有名称（或别名）与同类型资产名称相同、且尚未绑定的实体才会匹配。' });
      return;
    }
    const lines = data.suggestions.slice(0, MAX_SUGGESTION_LINES).map((item) => `${item.entityName} → ${item.assetName}`);
    if (data.suggestions.length > MAX_SUGGESTION_LINES) lines.push(`……另有 ${data.suggestions.length - MAX_SUGGESTION_LINES} 个`);
    const confirmed = await aiUi.confirm({
      title: '按名称自动匹配',
      message: `将建立 ${data.suggestions.length} 个形象绑定，已有的绑定不受影响：`,
      details: lines,
      confirmText: '建立绑定',
      cancelText: '取消'
    });
    if (!confirmed || !session) return;
    let failed = 0;
    for (const item of data.suggestions) {
      const result = await request(REQUEST_BIND, { episodeId, entityId: item.entityId, assetId: item.assetId, purpose: PURPOSE_VISUAL }, message);
      if (!result) failed += 1;
    }
    await refresh();
    if (failed > 0 && session) setMessage(session.message, `有 ${failed} 个绑定没有建立成功，请手动处理。`, true);
  }

  /** 顶部汇总：已绑定的实体数；有未绑定的给出警告。 */
  function renderSummary(view) {
    const total = view.entities.length;
    const bound = view.entities.filter((entity) => entity.visual.length > 0).length;
    session.summary.textContent = total === 0 ? '这一集所在的作品没有可绑定的实体。' : `已绑定 ${bound} / 共 ${total} 个实体${bound < total ? '，未绑定的实体生成时没有参考图' : ''}`;
    session.summary.className = total > 0 && bound < total ? 'status-warning' : 'description';
  }

  /** 重新读取并刷新面板；还没有选择集时只显示提示。 */
  async function refresh() {
    if (!session) return;
    const current = session;
    if (current.episodeId === null) {
      current.summary.textContent = '请先选择一个有分镜脚本的集。';
      current.summary.className = 'description';
      current.listElement.textContent = '';
      current.matchButton.setDisabled(true);
      return;
    }
    try {
      const view = await window.hostBridge.request(REQUEST_VIEW, { episodeId: current.episodeId });
      if (session !== current) return;
      current.view = view;
      renderSummary(view);
      current.listElement.textContent = '';
      current.listElement.append(...renderEntities(view.entities));
      current.matchButton.setDisabled(view.entities.length === 0);
    } catch (error) {
      if (session !== current) return;
      setMessage(current.message, errorText(error), true);
    }
  }

  /** 切换到另一集；集没有变化时不重复读取。 */
  function setEpisode(episodeId) {
    if (!session || session.episodeId === episodeId) return;
    session.episodeId = episodeId;
    session.view = null;
    void refresh();
  }

  /**
   * 创建实体绑定面板（检查器的“绑定”页签）；只创建一个实例，用 setEpisode 指定集。
   * @returns {{ element: HTMLElement, setEpisode: (episodeId: number|null) => void, refresh: () => Promise<void> }}
   */
  function create() {
    const message = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    const summary = aiUi.h('span', { class: 'description', text: '请先选择一个有分镜脚本的集。' });
    const matchButton = aiUi.button({ text: '按名称自动匹配', disabled: true, onClick: () => void autoMatch() });
    const listElement = aiUi.h('div', { class: 'wb-bind-list' });
    const element = aiUi.h('div', { class: 'wb-bind' }, aiUi.h('div', { class: 'wb-bind__bar' }, summary, matchButton.element), message, listElement);
    session = { episodeId: null, view: null, message, summary, listElement, matchButton };
    return { element, setEpisode, refresh };
  }

  window.aiBindings = { create };
})();
