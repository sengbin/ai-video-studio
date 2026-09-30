// ------------------------------------------------------------------------
// 名称：stage.js
// 说明：创意阶段产出页脚本：显示生成进度与章节，编辑并保存章节，确认采用、取消、重试、重新生成、查看原始输出。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：请求与事件名称与 src/app/pages/stage-handlers.ts、src/app/forms/work-form.ts 一致；依赖 form/form-runtime.js（aiForm）与 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'stage.load';
  const REQUEST_APPROVE = 'stage.approve';
  const REQUEST_CANCEL = 'stage.cancel';
  const REQUEST_RETRY = 'stage.retry';
  const REQUEST_SAVE_CHAPTER = 'stage.saveChapter';
  const REQUEST_RAW_OUTPUT = 'stage.rawOutput';
  const EVENT_CHANGED = 'stage.changed';
  const FORM_REGENERATE = 'work.regenerate';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const REFRESH_DELAY_MS = 150;
  const SOURCE_LABELS = { text: '文字灵感', image: '灵感图片', novel: '小说原文' };
  const KIND_LABELS = { single: '单个短视频', series: '多集短片' };

  const { formatRelativeTime, stageStatusLabel, stageStatusClass } = window.pageFormat;

  const root = document.getElementById('app');
  /** 当前页面显示的视图；尚未加载成功时为 null。 */
  let view = null;
  /** 用户在版本下拉中固定查看的版本；为 null 时始终显示最新版本。 */
  let pinnedRunId = null;
  let latestRunId = null;
  let selectedSeq = null;
  let loadError = '';
  let isLoading = true;
  let isFormOpen = false;
  let refreshTimer = 0;
  /** 编辑器当前对应的“版本:章节”，用来判断切换后是否需要重建。 */
  let editorKey = '';
  let editorDirty = false;
  let editorControls = null;

  let headerElement = null;
  let messageElement = null;
  let progressElement = null;
  let bodyElement = null;

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
      return await window.hostBridge.request(name, payload);
    } catch (error) {
      showMessage((error && error.message) || GENERIC_ERROR_TEXT, true);
      return undefined;
    }
  }

  /** 有未保存的章节修改时询问是否放弃；没有修改直接返回 true。 */
  async function confirmDiscardEdits() {
    if (!editorDirty) return true;
    return aiUi.confirm({
      title: '放弃修改',
      message: '当前章节有未保存的修改，放弃这些修改？',
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      variant: 'danger'
    });
  }

  /** 加载视图；showLoading 为 false 时保留现有内容（后台刷新）。 */
  async function loadView(showLoading) {
    if (showLoading) {
      isLoading = true;
      render();
    }
    loadError = '';
    try {
      const next = await window.hostBridge.request(REQUEST_LOAD, pinnedRunId === null ? undefined : { id: pinnedRunId });
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
      loadError = (error && error.message) || '创意产出加载失败。';
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

  /** 确认采用：说明影响后请求宿主。 */
  async function approve() {
    const confirmed = await aiUi.confirm({
      title: '确认采用',
      message: `确认采用“${view.work.name}”的创意 v${view.run.version}？确认后它将作为后续剧本阶段的依据。`,
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
    isFormOpen = true;
    try {
      await aiForm.open({ form: FORM_REGENERATE, params: { workId: view.work.id } });
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
    editorDirty = false;
    pinnedRunId = runId === latestRunId ? null : runId;
    await loadView(false);
  }

  /** 选择章节；有未保存的修改时先确认。 */
  async function selectChapter(seq) {
    if (seq === selectedSeq) return;
    if (!(await confirmDiscardEdits())) return;
    editorDirty = false;
    selectedSeq = seq;
    renderBody();
  }

  /** 保存当前章节；已确认的版本被编辑时先提示会回到待确认。 */
  async function saveChapter() {
    const { title, content } = editorControls;
    if (view.actions.editNeedsConfirm) {
      const confirmed = await aiUi.confirm({
        title: '保存修改',
        message: '该版本已确认采用。保存后将回到待确认，需要重新确认。',
        confirmText: '保存',
        cancelText: '取消'
      });
      if (!confirmed) return;
    }
    const result = await runAction(REQUEST_SAVE_CHAPTER, {
      id: view.run.id,
      seq: selectedSeq,
      title: title.getValue(),
      content: content.getValue()
    });
    if (result) {
      editorDirty = false;
      await loadView(false);
      showMessage('已保存。', false);
    }
  }

  /** 状态文字：颜色之外始终带文字。 */
  function renderStatus() {
    const { run } = view;
    const progress = run.progress && run.display === 'running' ? `（${run.progress.step}）` : '';
    return aiUi.h('span', { class: stageStatusClass(run.display), text: `${stageStatusLabel(run.display)}${progress}` });
  }

  /** 顶部：标题、作品信息、版本、状态与操作按钮。 */
  function renderHeader() {
    headerElement.textContent = '';
    if (!view) return;
    const { work, run, actions, versions } = view;

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
      aiUi.h('h1', { text: `${work.name} › 创意` }),
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

  /** 状态提示与进度条：生成中显示进度；失败、已取消显示原因。 */
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
    } else if (run.display === 'failed') {
      progressElement.append(
        aiUi.h('p', { class: 'status-error', text: `生成失败：${run.errorMessage || '未知原因'}。已完成的章节已保留，可点“重试”继续。` })
      );
    } else if (run.display === 'canceled') {
      progressElement.append(aiUi.h('p', { class: 'description', text: '已取消生成，已完成的章节已保留，可点“重试”继续。' }));
    }
  }

  /** 章节字数提示：少于下限或超过上限时给出文字说明。 */
  function wordHintText(chapter) {
    if (!view.params) return '';
    if (chapter.wordHint === 'short') return `少于设定下限 ${view.params.chapterMinWords} 字`;
    if (chapter.wordHint === 'long') return `超过设定上限 ${view.params.chapterMaxWords} 字`;
    return '';
  }

  /** 章节列表：标题、字数与字数提示；当前章节高亮。 */
  function renderChapterList() {
    const { chapters, totalWords } = view;
    const items = chapters.map((chapter) => {
      const hint = wordHintText(chapter);
      const isSelected = chapter.seq === selectedSeq;
      return aiUi.h(
        'button',
        {
          class: isSelected ? 'stage-chapter is-selected' : 'stage-chapter',
          attrs: { type: 'button', 'aria-current': isSelected ? 'true' : undefined },
          on: { click: () => void selectChapter(chapter.seq) }
        },
        aiUi.h('span', { class: 'stage-chapter__title', text: `${chapter.seq}. ${chapter.title}` }),
        aiUi.h('span', { class: 'stage-chapter__meta', text: `${chapter.wordCount} 字` }),
        hint ? aiUi.h('span', { class: 'stage-chapter__hint status-warning', text: hint }) : null
      );
    });
    return aiUi.h(
      'aside',
      { class: 'stage-chapters' },
      aiUi.h('p', { class: 'description', text: `共 ${chapters.length} 章，共 ${totalWords} 字` }),
      chapters.length === 0 ? aiUi.h('p', { class: 'description', text: '章节生成后会陆续显示在这里。' }) : null,
      items
    );
  }

  /** 不能编辑时的原因。 */
  function readonlyReason() {
    const { run, actions } = view;
    if (actions.canEdit) return '';
    if (run.display === 'running') return '生成中，暂不能编辑。';
    if (run.display === 'failed' || run.display === 'canceled') return '生成尚未成功，暂不能编辑。';
    return '历史版本只读；如需修改，请切换到最新版本。';
  }

  /** 章节编辑区：切换章节时重建；同一章节有未保存的修改时保留输入。 */
  function renderEditor(chapter) {
    const key = `${view.run.id}:${chapter.seq}:${view.actions.canEdit}:${view.actions.editNeedsConfirm}`;
    if (editorControls && editorKey === key) {
      if (!editorDirty) {
        editorControls.title.setValue(chapter.title);
        editorControls.content.setValue(chapter.content);
      }
      return editorControls.element;
    }

    editorKey = key;
    editorDirty = false;
    const markDirty = () => {
      editorDirty = true;
    };
    const canEdit = view.actions.canEdit;
    const title = aiUi.textInput({ value: chapter.title, ariaLabel: '章节标题', disabled: !canEdit, onChange: markDirty });
    const content = aiUi.textArea({ value: chapter.content, ariaLabel: '章节正文', disabled: !canEdit, onChange: markDirty });
    const reason = readonlyReason();
    const saveButton = aiUi.button({ text: '保存本章', variant: 'primary', onClick: () => void saveChapter() });

    const element = aiUi.h(
      'section',
      { class: 'stage-editor' },
      aiUi.h('div', { class: 'stage-editor__title' }, title.element),
      aiUi.h('div', { class: 'stage-editor__content' }, content.element),
      reason ? aiUi.h('p', { class: 'description', text: reason }) : null,
      canEdit ? aiUi.h('div', { class: 'stage-editor__actions' }, saveButton.element) : null
    );
    editorControls = { key, element, title, content };
    return element;
  }

  /** 主体：章节列表与编辑区。 */
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
    if (!view) return;

    const { chapters } = view;
    if (chapters.length === 0) {
      editorControls = null;
      editorKey = '';
      bodyElement.append(renderChapterList());
      return;
    }
    if (!chapters.some((chapter) => chapter.seq === selectedSeq)) selectedSeq = chapters[0].seq;
    const chapter = chapters.find((item) => item.seq === selectedSeq);
    const wordHint = wordHintText(chapter);
    bodyElement.append(
      renderChapterList(),
      aiUi.h(
        'div',
        { class: 'stage-detail' },
        aiUi.h('p', { class: 'description', text: `本章 ${chapter.wordCount} 字${wordHint ? `（${wordHint}）` : ''}` }),
        renderEditor(chapter)
      )
    );
  }

  function render() {
    renderHeader();
    renderProgress();
    renderBody();
  }

  /** 渲染页面骨架。 */
  function renderPage() {
    headerElement = aiUi.h('header', { class: 'stage-header' });
    messageElement = aiUi.h('p', { class: 'stage-message', hidden: true, attrs: { role: 'status' } });
    progressElement = aiUi.h('div', { class: 'stage-progress-area' });
    bodyElement = aiUi.h('div', { class: 'stage-body' });
    root.append(headerElement, messageElement, progressElement, bodyElement);
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, scheduleRefresh);
  void loadView(true);
})();
