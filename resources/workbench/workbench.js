// ------------------------------------------------------------------------
// 名称：workbench.js
// 说明：生成工作台页脚本：选择作品的一集和视频模型参数，逐个或批量提交镜头生成视频；显示每个镜头的任务状态与历史，失败时显示平台返回的具体原因，支持取消、编辑镜头后再次生成、打开结果视频。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求与事件名称与 src/app/pages/workbench-handlers.ts 一致；“编辑镜头”“确认分镜脚本”复用 stage/stage.js 的产出层（aiStage）；依赖 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_CATALOG = 'workbench.catalog';
  const REQUEST_EPISODE = 'workbench.episode';
  const REQUEST_SUBMIT = 'workbench.submit';
  const REQUEST_CANCEL = 'workbench.cancel';
  const REQUEST_OPEN_RESULT = 'workbench.openResult';
  const EVENT_CHANGED = 'workbench.changed';
  const STAGE_STORYBOARD = 'storyboard_script';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const REFRESH_DELAY_MS = 150;
  const PREFERRED_RESOLUTION = '720P';
  const AUDIO_MODE_LABELS = { native: '模型生成声音', none: '无声' };
  const ACTIVE_STATUSES = ['waiting', 'queued', 'running'];
  const STATUS_CLASSES = {
    waiting: 'status-warning',
    queued: 'status-warning',
    running: 'status-warning',
    succeeded: 'status-success',
    failed: 'status-error',
    canceled: 'description'
  };
  const KILOBYTE = 1024;
  const MEGABYTE = 1024 * KILOBYTE;

  const { formatRelativeTime, stageStatusLabel } = window.pageFormat;

  const root = document.getElementById('app');
  /** 工作台清单：可选的作品、集与可用的视频模型；尚未加载成功时为 null。 */
  let catalog = null;
  /** 当前选择的集，值为“作品标识:集标识”；没有可选的集时为空串。 */
  let episodeKey = '';
  /** 当前选择的生成参数。 */
  const params = { modelId: '', aspectRatio: '', resolution: '', audioMode: '' };
  /** 当前集的工作台视图；尚未加载成功时为 null。 */
  let view = null;
  let loadError = '';
  let isLoading = true;
  let refreshTimer = 0;
  /** 正在提交的镜头标识，避免重复点击。 */
  const submitting = new Set();
  /** 工具栏当前对应的选项标记，选项变化时才重建，避免后台刷新关闭用户打开的下拉。 */
  let toolbarKey = null;
  let toolbarElement = null;
  let messageElement = null;
  let contentElement = null;

  /** 取错误载荷中的说明文字：有字段错误时列出各项，否则用错误说明。 */
  function errorText(error) {
    const fields = error && error.fieldErrors ? Object.values(error.fieldErrors) : [];
    if (fields.length > 0) return fields.join('\n');
    return (error && error.message) || GENERIC_ERROR_TEXT;
  }

  /** 在操作结果区显示文字（可多行）；空串表示清除。 */
  function showMessage(text, isError) {
    messageElement.textContent = text;
    messageElement.className = isError ? 'wb-message status-error' : 'wb-message status-success';
    messageElement.hidden = text === '';
  }

  /** 发起请求，失败时在操作结果区显示原因；成功返回响应数据，失败返回 undefined。 */
  async function runAction(name, payload) {
    showMessage('', false);
    try {
      return await window.hostBridge.request(name, payload);
    } catch (error) {
      showMessage(errorText(error), true);
      return undefined;
    }
  }

  /** 把“作品标识:集标识”拆成数字。 */
  function parseEpisodeKey(key) {
    const [workId, episodeId] = key.split(':').map(Number);
    return { workId, episodeId };
  }

  /** 全部可选的集，作为下拉选项。 */
  function episodeOptions() {
    return catalog.works.flatMap((work) =>
      work.episodes.map((episode) => ({
        value: `${work.id}:${episode.episodeId}`,
        label: `${work.name} › 第 ${episode.seq} 集${episode.title ? ` ${episode.title}` : ''}（${stageStatusLabel(episode.display)}）`
      }))
    );
  }

  function selectedModel() {
    return catalog ? catalog.models.find((model) => String(model.id) === params.modelId) : undefined;
  }

  /** 让参数保持在当前模型支持的范围内：不合法的值换成默认值。 */
  function normalizeParams() {
    if (!catalog) return;
    if (!catalog.models.some((model) => String(model.id) === params.modelId)) {
      params.modelId = catalog.models.length > 0 ? String(catalog.models[0].id) : '';
    }
    const model = selectedModel();
    const pick = (current, values, preferred) =>
      values.includes(current) ? current : preferred && values.includes(preferred) ? preferred : values[0] || '';
    params.aspectRatio = pick(params.aspectRatio, model ? model.aspectRatios : []);
    params.resolution = pick(params.resolution, model ? model.resolutions : [], PREFERRED_RESOLUTION);
    params.audioMode = pick(params.audioMode, model ? model.audioModes : [], 'native');
    const keys = episodeOptions().map((option) => option.value);
    if (!keys.includes(episodeKey)) episodeKey = keys[0] || '';
  }

  /** 工具栏：集、模型、画幅、分辨率、声音；选项没有变化时保持原样。 */
  function renderToolbar() {
    const model = selectedModel();
    const key = JSON.stringify([episodeOptions(), catalog.models, episodeKey, params]);
    if (key === toolbarKey) return;
    toolbarKey = key;
    toolbarElement.textContent = '';

    const makeSelect = (className, ariaLabel, options, value, onChange) => {
      const select = aiUi.select({ options, value, allowEmpty: false, ariaLabel, onChange });
      toolbarElement.append(aiUi.h('div', { class: className }, select.element));
    };

    makeSelect('wb-filter wb-filter--episode', '选择集', episodeOptions(), episodeKey, (value) => {
      episodeKey = value;
      view = null;
      isLoading = true;
      render();
      void loadEpisode(false);
    });
    if (catalog.models.length === 0) return;
    makeSelect(
      'wb-filter wb-filter--model',
      '视频模型',
      catalog.models.map((item) => ({ value: String(item.id), label: `${item.displayName}（${item.providerName}）` })),
      params.modelId,
      (value) => {
        params.modelId = value;
        normalizeParams();
        toolbarKey = null;
        renderToolbar();
        render();
      }
    );
    if (model.aspectRatios.length > 0) {
      makeSelect('wb-filter wb-filter--param', '画幅', model.aspectRatios, params.aspectRatio, (value) => (params.aspectRatio = value));
    }
    if (model.resolutions.length > 0) {
      makeSelect('wb-filter wb-filter--param', '分辨率', model.resolutions, params.resolution, (value) => (params.resolution = value));
    }
    if (model.audioModes.length > 0) {
      makeSelect(
        'wb-filter wb-filter--audio',
        '声音',
        model.audioModes.map((mode) => ({ value: mode, label: AUDIO_MODE_LABELS[mode] || mode })),
        params.audioMode,
        (value) => (params.audioMode = value)
      );
    }
  }

  /** 字节数显示为 KB 或 MB。 */
  function formatSize(bytes) {
    return bytes >= MEGABYTE ? `${(bytes / MEGABYTE).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / KILOBYTE))} KB`;
  }

  /** 弹出分镜脚本产出层，用来编辑镜头或确认采用。 */
  function openStoryboard() {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    aiStage.open(workId, STAGE_STORYBOARD, episodeId);
  }

  /** 提交镜头；成功后汇总已提交的镜头、被拒绝的原因和提醒。 */
  async function submit(shots) {
    if (!view || shots.length === 0) return;
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    shots.forEach((shot) => submitting.add(shot.id));
    render();
    const result = await runAction(REQUEST_SUBMIT, {
      workId,
      episodeId,
      shotIds: shots.map((shot) => shot.id),
      params: {
        modelId: Number(params.modelId),
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        audioMode: params.audioMode
      }
    });
    shots.forEach((shot) => submitting.delete(shot.id));
    if (result) {
      const lines = [];
      if (result.submitted.length > 0) lines.push(`已提交 ${result.submitted.length} 个镜头，生成需要几分钟，完成后会自动更新。`);
      for (const item of result.submitted) for (const warning of item.warnings) lines.push(`镜头 ${item.seq}：${warning}`);
      for (const item of result.rejected) lines.push(`镜头 ${item.seq || item.shotId} 未提交：${item.issues.join('；')}`);
      showMessage(lines.join('\n'), result.submitted.length === 0);
    }
    await loadEpisode(false);
  }

  /** 取消进行中的任务；生成中的任务说明平台上可能仍会继续。 */
  async function cancelJob(job) {
    const isRunning = job.status === 'running';
    const confirmed = await aiUi.confirm({
      title: '取消任务',
      message: isRunning
        ? '确认取消这个任务？取消后不再等待结果；如果平台不支持取消，平台上的任务可能仍会继续生成并计费。'
        : '确认取消这个排队中的任务？',
      confirmText: '取消任务',
      cancelText: '保留',
      variant: 'danger'
    });
    if (!confirmed) return;
    const result = await runAction(REQUEST_CANCEL, { jobId: job.id });
    if (result && isRunning && !result.remoteCanceled) {
      showMessage('已停止等待这个任务的结果。平台不支持取消，平台上的任务可能仍会继续生成并计费。', false);
    }
    await loadEpisode(false);
  }

  async function openResult(result) {
    await runAction(REQUEST_OPEN_RESULT, { resultId: result.id });
  }

  /** 失败原因：分类名称、平台返回的原文、错误码和处理建议。 */
  function renderFailure(failure) {
    return aiUi.h(
      'div',
      { class: 'wb-failure' },
      aiUi.h('div', { class: 'status-error wb-failure__label', text: `失败：${failure.label}` }),
      aiUi.h('div', { class: 'wb-failure__message', text: failure.message }),
      failure.code ? aiUi.h('div', { class: 'description', text: `错误码：${failure.code}` }) : null,
      aiUi.h('div', { class: 'description', text: failure.hint })
    );
  }

  /** 一次任务的状态：状态文字、失败原因或结果信息、提醒。 */
  function renderJob(job) {
    const parts = [
      aiUi.h(
        'div',
        { class: 'wb-job__head' },
        aiUi.h('span', { class: STATUS_CLASSES[job.status] || 'description', text: job.statusLabel }),
        aiUi.h('span', { class: 'description', text: `第 ${job.attempt} 次 · ${job.modelName} · ${formatRelativeTime(job.finishedAt || job.createdAt)}` })
      )
    ];
    if (job.failure) parts.push(renderFailure(job.failure));
    if (job.result) {
      const { durationSeconds, sizeBytes, hasAudio } = job.result;
      const info = [durationSeconds === null ? '' : `${durationSeconds} 秒`, formatSize(sizeBytes), hasAudio ? '有声' : '无声'].filter(Boolean);
      parts.push(
        aiUi.h(
          'div',
          { class: 'wb-result' },
          aiUi.h('span', { class: 'description', text: info.join(' · ') }),
          aiUi.button({ text: '打开视频', compact: true, onClick: () => void openResult(job.result) }).element
        )
      );
    }
    for (const warning of job.warnings) parts.push(aiUi.h('div', { class: 'description', text: `提醒：${warning}` }));
    return aiUi.h('div', { class: 'wb-job' }, parts);
  }

  /** 镜头的生成状态：最新一次任务，更早的任务折叠在“历史”里。 */
  function renderShotStatus(shot) {
    if (shot.jobs.length === 0) return aiUi.h('span', { class: 'description', text: '尚未生成' });
    const [latest, ...older] = shot.jobs;
    return aiUi.h(
      'div',
      {},
      renderJob(latest),
      older.length > 0
        ? aiUi.h(
            'details',
            { class: 'wb-history' },
            aiUi.h('summary', { text: `历史记录（${older.length} 次）` }),
            older.map((job) => renderJob(job))
          )
        : null
    );
  }

  /** 镜头内容：画面动作、时长与声音数量、出场实体（未绑定资产的会标明）。 */
  function renderShotContent(shot) {
    return aiUi.h(
      'div',
      { class: 'wb-shot' },
      aiUi.h('div', { class: 'wb-shot__action', text: shot.action, attrs: { title: shot.action } }),
      aiUi.h('div', { class: 'description', text: `${shot.durationSeconds} 秒 · ${shot.soundCount} 条声音` }),
      shot.entities.length > 0
        ? aiUi.h(
            'div',
            { class: 'wb-chips' },
            shot.entities.map((entity) => aiUi.chip({ text: entity.bound ? entity.name : `${entity.name} · 未绑定资产` }))
          )
        : null
    );
  }

  /** 镜头的操作：任务进行中显示“取消”，否则显示“生成”或“重新生成”；始终可以编辑镜头。 */
  function renderShotActions(shot) {
    const active = shot.jobs.find((job) => ACTIVE_STATUSES.includes(job.status));
    const canSubmit = view.canGenerate && Boolean(selectedModel()) && !submitting.has(shot.id);
    const buttons = [];
    if (active) {
      buttons.push(aiUi.button({ text: '取消', compact: true, variant: 'danger', ariaLabel: `取消镜头 ${shot.seq} 的任务`, onClick: () => void cancelJob(active) }));
    } else {
      buttons.push(
        aiUi.button({
          text: shot.jobs.length === 0 ? '生成' : '重新生成',
          compact: true,
          variant: 'primary',
          disabled: !canSubmit,
          ariaLabel: `${shot.jobs.length === 0 ? '生成' : '重新生成'}镜头 ${shot.seq}`,
          onClick: () => void submit([shot])
        })
      );
    }
    buttons.push(aiUi.button({ text: '编辑镜头', compact: true, ariaLabel: `编辑镜头 ${shot.seq}`, onClick: openStoryboard }));
    return buttons.map((button) => button.element);
  }

  const SHOT_COLUMNS = [
    {
      title: '镜头',
      width: 140,
      render: (shot) => aiUi.tableMainCell({ text: `镜头 ${shot.seq}`, description: [shot.shotSize, shot.sceneLabel].filter(Boolean).join(' · ') })
    },
    { title: '内容', minWidth: 220, render: renderShotContent },
    { title: '生成状态', minWidth: 260, render: renderShotStatus },
    { title: '操作', type: 'actions', render: renderShotActions }
  ];

  /** 空状态和错误状态。 */
  function renderState(text, button) {
    return aiUi.h('div', { class: 'wb-state' }, aiUi.h('p', { class: 'description', text }), button && button.element);
  }

  /** 内容区上方的提示：没有可用模型、分镜脚本未确认。 */
  function renderNotices() {
    const notices = [];
    if (catalog.models.length === 0) {
      notices.push(aiUi.h('p', { class: 'status-warning wb-notice', text: '没有可用的视频模型。请在“模型设置”中启用服务商、填写访问密钥并启用视频模型。' }));
    }
    if (view && view.blockReason) {
      notices.push(
        aiUi.h(
          'div',
          { class: 'wb-notice' },
          aiUi.h('span', { class: 'status-warning', text: view.blockReason }),
          aiUi.button({ text: '查看分镜脚本', compact: true, onClick: openStoryboard }).element
        )
      );
    }
    return notices;
  }

  /** 批量操作：提交还没有结果也没有进行中任务的镜头。 */
  function renderBatchBar() {
    const pending = view.shots.filter(
      (shot) => !submitting.has(shot.id) && !shot.jobs.some((job) => ACTIVE_STATUSES.includes(job.status) || job.status === 'succeeded')
    );
    const enabled = view.canGenerate && Boolean(selectedModel()) && pending.length > 0;
    return aiUi.h(
      'div',
      { class: 'wb-batch' },
      aiUi.button({
        text: `生成未完成的镜头（${pending.length}）`,
        variant: 'primary',
        disabled: !enabled,
        onClick: () => void submit(pending)
      }).element,
      aiUi.button({ text: '查看分镜脚本', onClick: openStoryboard }).element
    );
  }

  /** 按当前状态刷新内容区。 */
  function render() {
    contentElement.textContent = '';
    if (isLoading) {
      contentElement.append(renderState('加载中…'));
      return;
    }
    if (loadError) {
      contentElement.append(renderState(loadError, aiUi.button({ text: '重试', onClick: () => void loadAll(true) })));
      return;
    }
    if (catalog.works.length === 0) {
      contentElement.append(renderState('还没有分镜脚本。请先在“分镜”列表中为作品生成分镜脚本并确认采用。'));
      return;
    }
    contentElement.append(...renderNotices());
    if (!view) return;
    contentElement.append(
      renderBatchBar(),
      view.shots.length === 0 ? renderState('这一集没有镜头。') : aiUi.table({ columns: SHOT_COLUMNS, rows: view.shots, ariaLabel: '镜头' }).element
    );
  }

  /** 加载当前集的视图。 */
  async function loadEpisode(showLoading) {
    if (!catalog || episodeKey === '') {
      view = null;
      render();
      return;
    }
    if (showLoading) {
      isLoading = true;
      render();
    }
    loadError = '';
    try {
      view = await window.hostBridge.request(REQUEST_EPISODE, parseEpisodeKey(episodeKey));
    } catch (error) {
      loadError = errorText(error);
    }
    isLoading = false;
    render();
  }

  /** 加载清单与当前集；showLoading 为 false 时保留现有内容（后台刷新）。 */
  async function loadAll(showLoading) {
    if (showLoading) {
      isLoading = true;
      render();
    }
    loadError = '';
    try {
      catalog = await window.hostBridge.request(REQUEST_CATALOG);
      normalizeParams();
      renderToolbar();
      // 作品被删除后，它的分镜脚本产出层没有意义，自动关闭。
      aiStage.closeMissing(catalog.works.map((work) => work.id));
    } catch (error) {
      loadError = errorText(error);
      isLoading = false;
      render();
      return;
    }
    await loadEpisode(false);
  }

  /** 数据变化后稍作合并再刷新，任务状态频繁变化时避免反复重绘。 */
  function scheduleRefresh() {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(() => void loadAll(false), REFRESH_DELAY_MS);
  }

  /** 渲染页面骨架：工具栏、操作结果、内容区。 */
  function renderPage() {
    toolbarElement = aiUi.h('div', { class: 'wb-toolbar' });
    document.getElementById('page-toolbar').append(toolbarElement);
    messageElement = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div');
    root.append(messageElement, contentElement);
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, scheduleRefresh);
  // 在“模型设置”里改了模型或密钥后切回本页，可用模型要随之更新。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefresh();
  });
  window.addEventListener('focus', scheduleRefresh);
  void loadAll(true);
})();
