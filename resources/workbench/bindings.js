// ------------------------------------------------------------------------
// 名称：bindings.js
// 说明：实体绑定面板（F9，“绑定素材”步骤）：顶部是绑定进度和“按名称自动匹配”，下面每个实体一行（名称、类型、绑定状态和“选择资产”），点开弹出页选择形象资产、设为主资产、解除、新建资产，角色实体可选择音色参考音频并试听；列表只显示所选镜头组出场的实体，按名称自动匹配也只针对这些实体。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求名称与 src/app/pages/binding-handlers.ts 一致；必须先于 workbench.js 加载；对外只有 window.aiBindings.create()，返回面板元素与 setEpisode、setEntities、refresh。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_VIEW = 'bindings.view';
  const REQUEST_BIND = 'bindings.bind';
  const REQUEST_UNBIND = 'bindings.unbind';
  const REQUEST_SET_PRIMARY = 'bindings.setPrimary';
  const REQUEST_SUGGEST = 'bindings.suggest';
  const REQUEST_VOICE_AUDIO = 'bindings.voiceAudio';
  const REQUEST_REFERENCE_IMAGE = 'bindings.referenceImage';

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

  /** 资产缩略图：点击弹出原图；音频显示“音频”，没有图显示“无图”。message 为失败提示的显示位置，默认随弹出页。 */
  function renderThumb(item, message) {
    if (item.thumbnail) {
      const name = item.assetName || item.name;
      return aiUi.h(
        'button',
        { class: 'wb-bind-thumb wb-bind-thumb--button', attrs: { type: 'button', title: '查看原图', 'aria-label': `查看原图：${name}` }, on: { click: () => void viewOriginal(item.assetId, name, message) } },
        aiUi.h('img', { class: 'wb-bind-thumb__image', attrs: { src: `data:${item.thumbnail.mime};base64,${item.thumbnail.data}`, alt: name } })
      );
    }
    return aiUi.h('div', { class: 'wb-bind-thumb wb-bind-thumb--empty', text: item.durationSeconds === null ? '无图' : '音频' });
  }

  /** 向宿主取资产的原图并弹出页查看；原图按页面大小缩放，过大时在页内滚动。 */
  async function viewOriginal(assetId, name, message) {
    const data = await request(REQUEST_REFERENCE_IMAGE, { assetId }, message || messageTarget());
    if (!data) return;
    const image = aiUi.h('img', { class: 'wb-bind-original', attrs: { src: `data:${data.mime};base64,${data.data}`, alt: name } });
    aiUi.openPage({ title: name, content: aiUi.h('div', { class: 'wb-bind-viewer' }, image), width: 640, height: 520, minWidth: 320, minHeight: 240, buttons: [{ id: 'close', text: '关闭', isCancel: true }] });
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
        : { title: '预览', width: 64, render: (asset) => renderThumb({ ...asset, assetId: asset.id, assetName: asset.name }, message) },
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

  /** 一条绑定：一行内左为缩略图与名称（下方是主资产标记、时长），右为操作；音色参考不显示缩略图，操作里带“试听”。 */
  function renderItem(item, siblingCount, withPreview) {
    const buttons = [];
    if (withPreview) buttons.push(renderVoicePreview(item));
    if (siblingCount > 1 && !item.isPrimary) {
      buttons.push(aiUi.button({ text: '设为主资产', compact: true, ariaLabel: `把${item.assetName}设为主资产`, onClick: () => void changeBinding(REQUEST_SET_PRIMARY, { id: item.id }) }).element);
    }
    buttons.push(aiUi.button({ text: '解除', compact: true, ariaLabel: `解除绑定：${item.assetName}`, onClick: () => void changeBinding(REQUEST_UNBIND, { id: item.id }) }).element);
    const showMeta = (siblingCount > 1 && item.isPrimary) || item.durationSeconds !== null;
    return aiUi.h(
      'div',
      { class: 'wb-bind-item' },
      withPreview ? null : renderThumb(item),
      aiUi.h(
        'div',
        { class: 'wb-bind-item__main' },
        aiUi.h('span', { class: 'wb-bind-item__name', text: item.assetName, attrs: { title: item.assetName } }),
        showMeta
          ? aiUi.h(
              'span',
              { class: 'wb-bind-item__meta' },
              siblingCount > 1 && item.isPrimary ? aiUi.chip({ text: '主资产' }) : null,
              item.durationSeconds === null ? null : aiUi.h('span', { class: 'description', text: `${item.durationSeconds} 秒` })
            )
          : null
      ),
      aiUi.h('div', { class: 'wb-bind-item__actions' }, buttons)
    );
  }

  /** 实体里的一个字段行：左为字段名（形象、音色），右为绑定列表与操作。 */
  function renderField(label, content) {
    return aiUi.h('div', { class: 'wb-bind-field' }, aiUi.h('span', { class: 'wb-bind-field__label', text: label }), aiUi.h('div', { class: 'wb-bind-field__body' }, content));
  }

  /** 音色参考的试听控件：点击后才向宿主读取音频内容；失败时在提示区显示原因，默认是面板提示区，选择页传自己的 message。 */
  function renderVoicePreview(item) {
    return aiUi.audioPreview({
      ariaLabel: `试听音色参考：${item.assetName}`,
      iconOnly: Boolean(item.message),
      load: () => request(REQUEST_VOICE_AUDIO, { assetId: item.assetId }, item.message || messageTarget())
    }).element;
  }

  /** 形象资产单元格：已绑定的资产与“选择资产”“新建资产”。 */
  function renderVisualCell(entity) {
    return renderField('形象', [
      entity.visual.length === 0
        ? aiUi.h('div', { class: 'wb-bind-empty status-warning', text: '未绑定' })
        : aiUi.h('div', { class: 'wb-bind-items' }, entity.visual.map((item) => renderItem(item, entity.visual.length))),
      aiUi.h(
        'div',
        { class: 'wb-bind-cell__actions' },
        aiUi.button({ text: entity.visual.length === 0 ? '选择资产' : '再选一个', compact: true, ariaLabel: `为${entity.name}选择资产`, onClick: () => pickVisual(entity) }).element,
        aiUi.button({ text: '新建资产', compact: true, ariaLabel: `按${entity.name}的设定新建${entity.kindLabel}资产`, onClick: () => void createAsset(entity) }).element
      )
    ]);
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
    return renderField('音色', [
      entity.voice.length === 0
        ? aiUi.h('div', { class: 'wb-bind-empty description', text: '未指定（只使用设定里的文字音色）' })
        : aiUi.h('div', { class: 'wb-bind-items' }, entity.voice.map((item) => renderItem(item, 1, true))),
      aiUi.h(
        'div',
        { class: 'wb-bind-cell__actions' },
        aiUi.button({ text: entity.voice.length === 0 ? '选择音色' : '更换音色', compact: true, ariaLabel: `为${entity.name}选择音色参考`, onClick: () => pickVoice(entity) }).element
      )
    ]);
  }

  /** 当前显示的实体：指定了实体范围（镜头组出场的实体）时只显示这些，否则是本集全部。 */
  function visibleEntities() {
    const entities = session.view ? session.view.entities : [];
    return session.entityIds === null ? entities : entities.filter((entity) => session.entityIds.has(entity.entityId));
  }

  /** 一个实体一行：名称与类型，右侧是绑定状态（文字加图标）和“选择资产”（已绑定时为“管理”）；具体的绑定在弹出页里处理。 */
  function renderRow(entity) {
    const isBound = entity.visual.length > 0;
    const stateText = !isBound ? '⚠ 未绑定' : entity.visual.length > 1 ? `✓ 已绑定 ${entity.visual.length} 个` : '✓ 已绑定';
    return aiUi.h(
      'div',
      { class: 'wb-entity-row' },
      aiUi.h('span', {}, entity.name, aiUi.h('span', { class: 'wb-entity-type', text: entity.kindLabel })),
      aiUi.h(
        'span',
        { class: `wb-entity-state${isBound ? ' wb-entity-state--bound' : ''}` },
        aiUi.h('span', { text: stateText }),
        aiUi.button({ text: isBound ? '管理' : '选择资产', compact: true, ariaLabel: `${isBound ? '管理' : '选择'}${entity.name}的资产`, onClick: () => openEntityDialog(entity.entityId) }).element
      )
    );
  }

  /** 实体列表：标题带数量，没有实体时给出说明。 */
  function renderRows() {
    const entities = visibleEntities();
    session.heading.textContent = `${session.entityIds === null ? '本集实体' : '本组实体'}（${entities.length}）`;
    session.listElement.textContent = '';
    if (entities.length === 0) session.listElement.append(aiUi.h('p', { class: 'description', text: '这一组没有出场实体。' }));
    else session.listElement.append(...entities.map(renderRow));
  }

  /** 汇总、列表和“按名称自动匹配”按钮按当前数据与实体范围重画。 */
  function renderAll() {
    renderSummary();
    renderRows();
    session.matchButton.setDisabled(!visibleEntities().some((entity) => entity.visual.length === 0));
  }

  /** 当前提示应显示的位置：绑定弹出页打开时在弹出页里，否则在面板里。 */
  function messageTarget() {
    return session.dialog ? session.dialog.message : session.message;
  }

  /** 一个实体的绑定弹出页：形象资产（选择、再选、设为主资产、解除、新建）和角色的音色参考；绑定变化后随面板一起刷新。 */
  function openEntityDialog(entityId) {
    const entity = session.view && session.view.entities.find((item) => item.entityId === entityId);
    if (!entity || session.dialog) return;
    const message = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    const body = aiUi.h('div', { class: 'wb-bind-dialog' });
    const handle = aiUi.openPage({
      title: `绑定资产：${entity.name}（${entity.kindLabel}）`,
      content: aiUi.h('div', {}, message, body),
      width: 460,
      height: 420,
      minWidth: 340,
      minHeight: 240,
      buttons: [{ id: 'close', text: '关闭', isCancel: true }]
    });
    const dialog = { entityId, message, body, handle };
    session.dialog = dialog;
    void handle.closed.then(() => {
      if (session && session.dialog === dialog) session.dialog = null;
    });
    renderDialog();
  }

  /** 按最新数据重画绑定弹出页；实体已不存在（如作品被删除）时关闭。 */
  function renderDialog() {
    const dialog = session.dialog;
    if (!dialog) return;
    const entity = session.view && session.view.entities.find((item) => item.entityId === dialog.entityId);
    if (!entity) {
      dialog.handle.close('api');
      return;
    }
    dialog.body.textContent = '';
    dialog.body.append(...[renderVisualCell(entity), renderVoiceCell(entity)].filter(Boolean));
  }

  /** 解除、设为主资产这类单次请求，完成后重新读取。 */
  async function changeBinding(name, payload) {
    if (!session) return;
    if (await request(name, payload, messageTarget())) await refresh();
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

  /** 按名称自动匹配：先列出将建立的绑定（只含当前显示的实体），确认后逐条写入。 */
  async function autoMatch() {
    if (!session) return;
    const { message, episodeId } = session;
    const data = await request(REQUEST_SUGGEST, { episodeId }, message);
    if (!data) return;
    const suggestions = session.entityIds === null ? data.suggestions : data.suggestions.filter((item) => session.entityIds.has(item.entityId));
    if (suggestions.length === 0) {
      await aiUi.alert({ title: '按名称自动匹配', message: '没有可以建立的绑定。只有名称（或别名）与同类型资产名称相同、且尚未绑定的实体才会匹配。' });
      return;
    }
    const lines = suggestions.slice(0, MAX_SUGGESTION_LINES).map((item) => `${item.entityName} → ${item.assetName}`);
    if (suggestions.length > MAX_SUGGESTION_LINES) lines.push(`……另有 ${suggestions.length - MAX_SUGGESTION_LINES} 个`);
    const confirmed = await aiUi.confirm({
      title: '按名称自动匹配',
      message: `将建立 ${suggestions.length} 个形象绑定，已有的绑定不受影响：`,
      details: lines,
      confirmText: '建立绑定',
      cancelText: '取消'
    });
    if (!confirmed || !session) return;
    let failed = 0;
    for (const item of suggestions) {
      const result = await request(REQUEST_BIND, { episodeId, entityId: item.entityId, assetId: item.assetId, purpose: PURPOSE_VISUAL }, message);
      if (!result) failed += 1;
    }
    await refresh();
    if (failed > 0 && session) setMessage(session.message, `有 ${failed} 个绑定没有建立成功，请手动处理。`, true);
  }

  /** 顶部汇总：当前显示的实体里已绑定的数量与进度条；有未绑定的用警告色并写明数量。 */
  function renderSummary() {
    const entities = visibleEntities();
    const total = entities.length;
    const bound = entities.filter((entity) => entity.visual.length > 0).length;
    const percent = total === 0 ? 0 : Math.round((bound / total) * 100);
    if (total === 0) {
      session.summary.textContent = session.entityIds === null ? '这一集所在的作品没有可绑定的实体。' : '这一组没有出场实体。';
      session.summary.className = 'description';
    } else {
      session.summary.textContent = bound < total ? `${bound} / ${total} 已绑定` : '✓ 已全部绑定';
      session.summary.className = bound < total ? 'status-warning' : 'status-success';
    }
    session.progress.hidden = total === 0;
    session.progress.setAttribute('aria-valuenow', String(percent));
    session.progressValue.style.width = `${percent}%`;
  }

  /** 重新读取并刷新面板；还没有选择集时只显示提示。 */
  async function refresh() {
    if (!session) return;
    const current = session;
    if (current.episodeId === null) {
      current.summary.textContent = '请先选择一个有分镜脚本的集。';
      current.summary.className = 'description';
      current.progress.hidden = true;
      current.heading.textContent = '';
      current.listElement.textContent = '';
      current.matchButton.setDisabled(true);
      return;
    }
    try {
      const view = await window.hostBridge.request(REQUEST_VIEW, { episodeId: current.episodeId });
      if (session !== current) return;
      current.view = view;
      renderAll();
      renderDialog();
    } catch (error) {
      if (session !== current) return;
      setMessage(current.message, errorText(error), true);
    }
  }

  /** 指定只显示哪些实体（所选镜头组出场的实体标识）；null 表示显示本集全部。范围没有变化时不重画。 */
  function setEntities(entityIds) {
    if (!session) return;
    const next = entityIds === null ? null : new Set(entityIds);
    const same = next === null ? session.entityIds === null : session.entityIds !== null && next.size === session.entityIds.size && [...next].every((id) => session.entityIds.has(id));
    if (same) return;
    session.entityIds = next;
    if (session.view) renderAll();
  }

  /** 切换到另一集；集没有变化时不重复读取。 */
  function setEpisode(episodeId) {
    if (!session || session.episodeId === episodeId) return;
    session.episodeId = episodeId;
    session.view = null;
    void refresh();
  }

  /**
   * 创建实体绑定面板（“绑定素材”步骤）；只创建一个实例，用 setEpisode 指定集、setEntities 指定显示哪些实体。
   * @returns {{ element: HTMLElement, setEpisode: (episodeId: number|null) => void, setEntities: (entityIds: number[]|null) => void, refresh: () => Promise<void> }}
   */
  function create() {
    const message = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    const summary = aiUi.h('span', { class: 'description', text: '请先选择一个有分镜脚本的集。' });
    const progressValue = aiUi.h('div', { class: 'wb-progress__value' });
    const progress = aiUi.h('div', { class: 'wb-progress', hidden: true, attrs: { role: 'progressbar', 'aria-label': '素材绑定进度', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 } }, progressValue);
    const matchButton = aiUi.button({ text: '按名称自动匹配', disabled: true, onClick: () => void autoMatch() });
    const heading = aiUi.h('h3', { class: 'wb-entity-heading' });
    const listElement = aiUi.h('div', { class: 'wb-entity-list' });
    const element = aiUi.h(
      'div',
      { class: 'wb-bind' },
      aiUi.h('div', { class: 'wb-bind__head' }, aiUi.h('strong', { text: '素材绑定进度' }), summary),
      progress,
      aiUi.h('p', { class: 'description', text: '先按名称自动匹配已有资产，剩余项逐个选择。未绑定的实体仍可生成，但只能按文字描述。' }),
      aiUi.h('div', { class: 'wb-bind__actions' }, matchButton.element),
      message,
      heading,
      listElement
    );
    session = { episodeId: null, view: null, entityIds: null, dialog: null, message, summary, progress, progressValue, heading, listElement, matchButton };
    return { element, setEpisode, setEntities, refresh };
  }

  window.aiBindings = { create };
})();
