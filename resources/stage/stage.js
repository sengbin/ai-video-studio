// ------------------------------------------------------------------------
// 名称：stage.js
// 说明：阶段产出层的外壳脚本：在所属页面内以弹出页面显示生成进度，提供版本、确认采用、取消、重试、重新生成、查看原始输出；各阶段自己的内容区由登记的“阶段内容”负责。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：通过 aiStage.open(workId, stage, episodeId?) 打开，同一作品的同一阶段（分镜脚本还要同一集）只有一个产出层；阶段内容由 stage-creative.js、stage-screenplay.js、stage-storyboard.js 通过 aiStage.registerStage 登记；请求载荷都带 workId 与 stage（分镜脚本还带 episodeId），事件名称与 src/app/pages/stage-handlers.ts 一致；依赖 form/form-runtime.js（aiForm）与 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'stage.load';
  const REQUEST_APPROVE = 'stage.approve';
  const REQUEST_CANCEL = 'stage.cancel';
  const REQUEST_RETRY = 'stage.retry';
  const REQUEST_RAW_OUTPUT = 'stage.rawOutput';
  const EVENT_CHANGED = 'stage.changed';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const REFRESH_DELAY_MS = 150;
  const PAGE_WIDTH = 960;
  const PAGE_HEIGHT = 640;
  const PAGE_MIN_WIDTH = 420;
  const PAGE_MIN_HEIGHT = 360;
  const SOURCE_LABELS = { text: '文字灵感', image: '灵感图片', novel: '小说原文' };
  const KIND_LABELS = { single: '单个短视频', series: '多集短片' };
  const STALE_TEXT = '上游产出已修改，本产出可能已过期。不会自动重新生成，请检查后决定是否重新生成。';

  const { formatRelativeTime, stageStatusLabel, stageStatusClass } = window.pageFormat;

  /**
   * 各阶段登记的“阶段内容”：
   * { stage, label, regenerateForm, keptNote, discardMessage, approveNote(view), confirmRegenerate?(view), titleSuffix?(view), create(context) }，
   * create 接收 { call, runAction, showMessage, reload, getView, confirmDiscard }，返回 { render(view, container), renderSummary(view), isDirty(), discard() }。
   */
  const providers = new Map();
  /** 已打开的产出层：“阶段:作品标识” → { workId, handle, refresh }。 */
  const openViews = new Map();

  /** 登记一个阶段的内容。 */
  function registerStage(provider) {
    providers.set(provider.stage, provider);
  }

  /** 产出层的键；分镜脚本按集区分。 */
  function viewKey(workId, stage, episodeId) {
    return episodeId ? `${stage}:${workId}:${episodeId}` : `${stage}:${workId}`;
  }

  /**
   * 为一个作品的一个阶段创建产出层：弹出页面、加载数据并随宿主事件刷新。
   * @param {number} workId 作品标识。
   * @param {string} stage 阶段，如 creative、screenplay、storyboard_script。
   * @param {number|null} episodeId 集标识，仅分镜脚本阶段使用。
   * @returns 弹出页面的句柄。
   */
  function createStageView(workId, stage, episodeId) {
    const provider = providers.get(stage);
    if (!provider) throw new Error(`没有登记阶段：${stage}`);

    /** 当前显示的视图；尚未加载成功时为 null。 */
    let view = null;
    /** 用户在版本下拉中固定查看的版本；为 null 时始终显示最新版本。 */
    let pinnedRunId = null;
    let latestRunId = null;
    let loadError = '';
    let isLoading = true;
    let isFormOpen = false;
    let refreshTimer = 0;
    let handle = null;

    const headerElement = aiUi.h('header', { class: 'stage-header' });
    const messageElement = aiUi.h('p', { class: 'stage-message', hidden: true, attrs: { role: 'status' } });
    const progressElement = aiUi.h('div', { class: 'stage-progress-area' });
    const bodyElement = aiUi.h('div', { class: 'stage-body' });
    const root = aiUi.h('div', { class: 'stage-view' }, headerElement, messageElement, progressElement, bodyElement);

    /** 发起带作品标识与阶段（分镜脚本还带集标识）的请求。 */
    function call(name, payload) {
      return window.hostBridge.request(name, { ...payload, workId, stage, ...(episodeId ? { episodeId } : {}) });
    }

    /** 阶段在标题里附加的文字，如分镜脚本的“ › 第 1 集”。 */
    function titleSuffix() {
      return provider.titleSuffix && view ? provider.titleSuffix(view) : '';
    }

    /** 在操作结果区显示文字；空串表示清除。 */
    function showMessage(text, isError) {
      messageElement.textContent = text;
      messageElement.className = isError ? 'stage-message status-error' : 'stage-message status-success';
      messageElement.hidden = text === '';
    }

    /** 发起请求，失败时在操作结果区显示原因；成功返回响应数据，失败返回 undefined。 */
    async function runAction(name, payload) {
      showMessage('', false);
      try {
        return await call(name, payload);
      } catch (error) {
        showMessage((error && error.message) || GENERIC_ERROR_TEXT, true);
        return undefined;
      }
    }

    /** 加载视图；showLoading 为 false 时保留现有内容（后台刷新）。 */
    async function loadView(showLoading) {
      if (showLoading) {
        isLoading = true;
        render();
      }
      loadError = '';
      try {
        const next = await call(REQUEST_LOAD, pinnedRunId === null ? {} : { id: pinnedRunId });
        // 出现了新的最新版本（如重新生成）：不再固定旧版本，直接显示新版本。
        const newLatestId = next.versions[0].id;
        if (latestRunId !== null && newLatestId !== latestRunId && pinnedRunId !== null) {
          pinnedRunId = null;
          latestRunId = newLatestId;
          return loadView(false);
        }
        latestRunId = newLatestId;
        // 版本或状态变了，之前的结果提示（如“已确认采用。”）已经过期。
        if (view && (next.run.id !== view.run.id || next.run.display !== view.run.display)) showMessage('', false);
        view = next;
      } catch (error) {
        loadError = (error && error.message) || `${provider.label}产出加载失败。`;
      }
      isLoading = false;
      render();
      return undefined;
    }

    /** 数据变化后稍作合并再刷新，生成进度频繁推送时避免反复重绘。 */
    function scheduleRefresh() {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void loadView(false), REFRESH_DELAY_MS);
    }

    const content = provider.create({
      call,
      runAction,
      showMessage,
      reload: () => loadView(false),
      getView: () => view,
      confirmDiscard: () => confirmDiscardEdits()
    });

    /** 有未保存的修改时询问是否放弃；没有修改直接返回 true。 */
    async function confirmDiscardEdits() {
      if (!content.isDirty()) return true;
      return aiUi.confirm({
        title: '放弃修改',
        message: provider.discardMessage,
        confirmText: '放弃修改',
        cancelText: '继续编辑',
        variant: 'danger'
      });
    }

    /** 确认采用：说明影响后请求宿主。 */
    async function approve() {
      const confirmed = await aiUi.confirm({
        title: '确认采用',
        message: `确认采用“${view.work.name}”的${provider.label}${titleSuffix().replace(' › ', ' ')} v${view.run.version}？${provider.approveNote(view)}`,
        confirmText: '确认采用'
      });
      if (!confirmed) return;
      if (await runAction(REQUEST_APPROVE, { id: view.run.id })) {
        await loadView(false);
        showMessage('已确认采用。', false);
      }
    }

    async function cancelGeneration() {
      await runAction(REQUEST_CANCEL, { id: view.run.id });
    }

    async function retryGeneration() {
      if (await runAction(REQUEST_RETRY, { id: view.run.id })) await loadView(false);
    }

    /** 弹出“重新生成”表单，初始值为上次使用的参数。 */
    async function regenerate() {
      if (isFormOpen || !(await confirmDiscardEdits())) return;
      if (provider.confirmRegenerate && !(await provider.confirmRegenerate(view))) return;
      isFormOpen = true;
      try {
        await aiForm.open({ form: provider.regenerateForm, params: { workId: view.work.id, ...(episodeId ? { episodeId } : {}) } });
      } finally {
        isFormOpen = false;
      }
    }

    /** 在弹出页面中显示失败时保留的模型原始输出。 */
    async function showRawOutput() {
      const result = await runAction(REQUEST_RAW_OUTPUT, { id: view.run.id });
      if (!result) return;
      aiUi.openPage({
        title: '模型原始输出',
        content: aiUi.h('pre', { class: 'stage-raw', text: result.text || '（没有保留原始输出）' }),
        width: 640,
        height: 420,
        buttons: [{ id: 'close', text: '关闭', variant: 'primary', isDefault: true, isCancel: true }]
      });
    }

    /** 切换版本：固定查看所选版本；选择最新版本等于取消固定。 */
    async function switchVersion(runId) {
      if (!(await confirmDiscardEdits())) {
        renderHeader();
        return;
      }
      content.discard();
      pinnedRunId = runId === latestRunId ? null : runId;
      await loadView(false);
    }

    /** 状态文字：颜色之外始终带文字。 */
    function renderStatus() {
      const { run } = view;
      const progress = run.progress && run.display === 'running' ? `（${run.progress.step}）` : '';
      return aiUi.h('span', { class: stageStatusClass(run.display), text: `${stageStatusLabel(run.display)}${progress}` });
    }

    /** 顶部：作品信息、版本、状态与操作按钮；作品名显示在弹出页面的标题行。 */
    function renderHeader() {
      headerElement.textContent = '';
      if (!view) return;
      const { work, run, actions, versions } = view;
      if (handle) handle.setTitle(`${work.name} › ${provider.label}${titleSuffix()}`);

      const versionSelect = aiUi.select({
        options: versions.map((item) => ({
          value: String(item.id),
          label: `v${item.version} · ${stageStatusLabel(item.display)}${item.isCurrent ? '（当前）' : ''}`
        })),
        value: String(run.id),
        allowEmpty: false,
        ariaLabel: '版本',
        onChange: (value) => void switchVersion(Number(value))
      });

      const buttons = [
        aiUi.button({ text: '确认采用', variant: 'primary', disabled: !actions.canApprove, onClick: () => void approve() }),
        actions.canCancel ? aiUi.button({ text: '取消生成', variant: 'danger', onClick: () => void cancelGeneration() }) : null,
        actions.canRetry ? aiUi.button({ text: '重试', onClick: () => void retryGeneration() }) : null,
        aiUi.button({ text: '重新生成', disabled: actions.canCancel, onClick: () => void regenerate() }),
        run.hasRawOutput ? aiUi.button({ text: '查看原始输出', onClick: () => void showRawOutput() }) : null
      ].filter(Boolean);

      const details = [
        `${KIND_LABELS[work.kind] || ''}`,
        SOURCE_LABELS[work.sourceType] || '',
        run.modelInfo ? `模型：${run.modelInfo}` : '',
        `开始于 ${formatRelativeTime(run.createdAt)}`
      ].filter(Boolean);

      headerElement.append(
        aiUi.h('p', { class: 'description', text: details.join(' · ') }),
        aiUi.h(
          'div',
          { class: 'stage-bar' },
          aiUi.h('div', { class: 'stage-bar__version' }, versionSelect.element),
          renderStatus(),
          aiUi.h('div', { class: 'stage-bar__buttons' }, buttons.map((button) => button.element))
        )
      );
    }

    /** 状态提示与进度条：生成中显示进度；失败、已取消显示原因；生成结束后显示上游变更提示与阶段自己的汇总。 */
    function renderProgress() {
      progressElement.textContent = '';
      if (!view) return;
      const { run } = view;
      if (run.display === 'running') {
        const total = run.progress ? Math.max(run.progress.total, 1) : 1;
        const done = run.progress ? run.progress.done : 0;
        const text = run.progress ? `${run.progress.step}（${run.progress.done} / ${run.progress.total}）` : '准备中…';
        progressElement.append(
          aiUi.h('progress', { class: 'stage-progress', attrs: { max: String(total), value: String(done), 'aria-label': '生成进度' } }),
          aiUi.h('p', { class: 'description', text })
        );
        return;
      }
      if (run.display === 'failed') {
        progressElement.append(
          aiUi.h('p', { class: 'status-error', text: `生成失败：${run.errorMessage || '未知原因'}。${provider.keptNote}，可点“重试”继续。` })
        );
      } else if (run.display === 'canceled') {
        progressElement.append(aiUi.h('p', { class: 'description', text: `已取消生成，${provider.keptNote}，可点“重试”继续。` }));
      }
      if (view.stale) progressElement.append(aiUi.h('p', { class: 'status-warning', text: STALE_TEXT }));
      if (run.display !== 'failed' && run.display !== 'canceled') {
        const summary = content.renderSummary(view);
        if (summary) progressElement.append(summary);
      }
    }

    /** 主体：加载中与错误由外壳显示，其余交给阶段内容。 */
    function renderBody() {
      bodyElement.textContent = '';
      if (isLoading) {
        bodyElement.append(aiUi.h('p', { class: 'description', text: '加载中…' }));
        return;
      }
      if (loadError) {
        bodyElement.append(
          aiUi.h('p', { class: 'description', text: loadError }),
          aiUi.button({ text: '重试', onClick: () => void loadView(true) }).element
        );
        return;
      }
      if (view) content.render(view, bodyElement);
    }

    function render() {
      renderHeader();
      renderProgress();
      renderBody();
    }

    handle = aiUi.openPage({
      title: provider.label,
      content: root,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      minWidth: PAGE_MIN_WIDTH,
      minHeight: PAGE_MIN_HEIGHT,
      beforeClose: () => confirmDiscardEdits()
    });
    const key = viewKey(workId, stage, episodeId);
    openViews.set(key, { workId, handle, refresh: scheduleRefresh });
    void handle.closed.then(() => {
      window.clearTimeout(refreshTimer);
      openViews.delete(key);
    });
    void loadView(true);
    return handle;
  }

  /**
   * 打开作品某个阶段的产出层；已经打开时聚焦已有的。
   * @param {number} workId 作品标识。
   * @param {string} stage 阶段，缺省为创意。
   * @param {number|null} episodeId 集标识，分镜脚本阶段必填。
   * @returns 弹出页面的句柄。
   */
  function open(workId, stage = 'creative', episodeId = null) {
    const existing = openViews.get(viewKey(workId, stage, episodeId));
    if (existing) {
      existing.handle.element.focus();
      return existing.handle;
    }
    return createStageView(workId, stage, episodeId);
  }

  /** 关闭作品已不存在的产出层（作品被删除，或随所属项目一起删除）。 */
  function closeMissing(existingWorkIds) {
    for (const entry of openViews.values()) {
      if (!existingWorkIds.includes(entry.workId)) entry.handle.close('api');
    }
  }

  // 一个作品任一阶段变化，都可能影响它的其他阶段（如上游变更提示），所以该作品的产出层一并刷新。
  window.hostBridge.onEvent(EVENT_CHANGED, (payload) => {
    for (const entry of openViews.values()) {
      if (payload && entry.workId === payload.workId) entry.refresh();
    }
  });

  window.aiStage = { open, closeMissing, registerStage };
})();
