// ------------------------------------------------------------------------
// 名称：workbench.js
// 说明：生成工作台页脚本：选择作品的一集，按“本集 → 作品 → 项目默认”的生成参数按镜头组提交生成（一组一次生成一个多镜头视频）；显示每组的镜头、总时长、任务状态与历史，失败时显示平台返回的具体原因；支持重新分组、拆分与合并镜头组、取消、编辑镜头后再次生成、打开结果视频。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求与事件名称与 src/app/pages/workbench-handlers.ts 一致；“编辑镜头”“确认分镜脚本”复用 stage/stage.js 的产出层（aiStage）；“实体绑定”由 workbench/bindings.js（aiBindings）提供，“生成参数”的合并与编辑由 workbench/profile.js（aiProfile）提供；依赖 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_CATALOG = 'workbench.catalog';
  const REQUEST_EPISODE = 'workbench.episode';
  const REQUEST_PROFILE = 'workbench.profile';
  const REQUEST_SAVE_PROFILE = 'workbench.saveProfile';
  const REQUEST_SUBMIT = 'workbench.submit';
  const REQUEST_REGROUP = 'workbench.regroup';
  const REQUEST_SPLIT_GROUP = 'workbench.splitGroup';
  const REQUEST_MERGE_GROUP = 'workbench.mergeGroup';
  const REQUEST_CANCEL = 'workbench.cancel';
  const REQUEST_OPEN_RESULT = 'workbench.openResult';
  const REQUEST_EXPORT_RESULT = 'workbench.exportResult';
  const REQUEST_REVEAL_RESULT = 'workbench.revealResult';
  const EVENT_CHANGED = 'workbench.changed';
  const STAGE_STORYBOARD = 'storyboard_script';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const REFRESH_DELAY_MS = 150;
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
  const ACTION_PREVIEW_LENGTH = 40;
  const AUDIO_MODE_LABELS = { native: '模型生成声音', none: '无声', external: '独立音轨' };
  const MS_PER_SECOND = 1000;
  const SECONDS_PER_MINUTE = 60;

  const { formatRelativeTime, stageStatusLabel } = window.pageFormat;

  const root = document.getElementById('app');
  /** 工作台清单：可选的作品、集与可用的视频模型；尚未加载成功时为 null。 */
  let catalog = null;
  /** 当前选择的集，值为“作品标识:集标识”；没有可选的集时为空串。 */
  let episodeKey = '';
  /** 当前集的生成参数视图（作品默认、本集覆盖、生效值）；尚未加载成功时为 null。 */
  let profile = null;
  /** 按清单与参数视图算出的生效参数（见 profile.js）；没有参数视图时为 null。 */
  let resolved = null;
  /** 当前集的工作台视图；尚未加载成功时为 null。 */
  let view = null;
  let loadError = '';
  let isLoading = true;
  let refreshTimer = 0;
  /** 正在提交的镜头组标识，避免重复点击。 */
  const submitting = new Set();
  /** 重新分组时填写的单组最长时长；用户没改过时跟随当前模型与分镜脚本设定。 */
  let regroupSeconds = '';
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
    return resolved ? resolved.model : undefined;
  }

  /** 生成参数是否可用于提交：选了可用模型，且各参数都在该模型支持的范围内。 */
  function paramsReady() {
    return Boolean(resolved && resolved.model) && Object.keys(resolved.issues).length === 0;
  }

  /** 按清单与参数视图重新算出生效参数。 */
  function updateResolved() {
    resolved = catalog && profile ? aiProfile.resolve(catalog, profile) : null;
  }

  /** 已选择的集不在清单里时（如被删除），改选第一个。 */
  function normalizeEpisodeKey() {
    if (!catalog) return;
    const keys = episodeOptions().map((option) => option.value);
    if (!keys.includes(episodeKey)) episodeKey = keys[0] || '';
  }

  /** 打开生成参数页：编辑作品默认与本集覆盖。 */
  function openProfile() {
    aiProfile.open({ getState: () => ({ catalog, profile }), save: saveProfile });
  }

  /** 保存某一级的参数修改，成功后用返回的视图刷新工具栏、提交按钮和参数页。 */
  async function saveProfile(scope, changes) {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    try {
      profile = await window.hostBridge.request(REQUEST_SAVE_PROFILE, { scope, workId, episodeId, changes });
    } catch (error) {
      return { ok: false, message: errorText(error) };
    }
    updateResolved();
    renderToolbar();
    render();
    aiProfile.refresh();
    return { ok: true };
  }

  /** 工具栏：集、当前生效参数的摘要与“生成参数”；内容没有变化时保持原样。 */
  function renderToolbar() {
    const summary = resolved ? aiProfile.summarize(resolved) : '';
    const key = JSON.stringify([episodeOptions(), episodeKey, summary, Boolean(profile)]);
    if (key === toolbarKey) return;
    toolbarKey = key;
    toolbarElement.textContent = '';
    if (episodeKey === '') return;

    const episodeSelect = aiUi.select({
      options: episodeOptions(),
      value: episodeKey,
      allowEmpty: false,
      ariaLabel: '选择集',
      onChange: (value) => {
        episodeKey = value;
        view = null;
        profile = null;
        updateResolved();
        isLoading = true;
        render();
        void loadEpisode(false);
      }
    });
    toolbarElement.append(aiUi.h('div', { class: 'wb-filter wb-filter--episode' }, episodeSelect.element));
    if (!profile) return;
    toolbarElement.append(
      aiUi.h('span', { class: 'description wb-toolbar__summary', text: summary, attrs: { title: summary } }),
      aiUi.button({ text: '生成参数', onClick: openProfile }).element
    );
  }

  /** 字节数显示为 KB 或 MB。 */
  function formatSize(bytes) {
    return bytes >= MEGABYTE ? `${(bytes / MEGABYTE).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / KILOBYTE))} KB`;
  }

  /** 截取动作文字用于列表显示。 */
  function preview(text) {
    return text.length > ACTION_PREVIEW_LENGTH ? `${text.slice(0, ACTION_PREVIEW_LENGTH)}…` : text;
  }

  /** 弹出分镜脚本产出层，用来编辑镜头或确认采用。 */
  function openStoryboard() {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    aiStage.open(workId, STAGE_STORYBOARD, episodeId);
  }

  function hasActiveJob(group) {
    return group.jobs.some((job) => ACTIVE_STATUSES.includes(job.status));
  }

  /** 所选模型单次最长时长；没有上限信息时为 null。 */
  function modelMaxSeconds() {
    const model = selectedModel();
    return model ? model.maxGroupSeconds : null;
  }

  /** 这一组是否超过所选模型单次最长时长。 */
  function exceedsModel(group) {
    const max = modelMaxSeconds();
    return max !== null && group.totalSeconds > max;
  }

  /** 提交镜头组；成功后汇总已提交的组、被拒绝的原因和提醒。 */
  async function submit(groups) {
    if (!view || groups.length === 0) return;
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    groups.forEach((group) => submitting.add(group.id));
    render();
    await runAction(REQUEST_SUBMIT, {
      workId,
      episodeId,
      groupIds: groups.map((group) => group.id),
      params: {
        modelId: Number(resolved.values.modelId),
        aspectRatio: resolved.values.aspectRatio,
        resolution: resolved.values.resolution,
        audioMode: resolved.values.audioMode
      }
    });
    groups.forEach((group) => submitting.delete(group.id));
    // 提交结果、被拒绝的原因和提醒由宿主在 VS Code 右下角通知，页面只刷新状态。
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

  /** 导出结果视频：宿主弹出“另存为”对话框，完成后在右下角通知。 */
  async function exportResult(result) {
    await runAction(REQUEST_EXPORT_RESULT, { resultId: result.id });
  }

  async function revealResult(result) {
    await runAction(REQUEST_REVEAL_RESULT, { resultId: result.id });
  }

  /** 在某个镜头之前拆开所在的组。 */
  async function splitBefore(shot) {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    if (await runAction(REQUEST_SPLIT_GROUP, { workId, episodeId, shotId: shot.id })) await loadEpisode(false);
  }

  /** 把一个组并入上一组。 */
  async function mergeIntoPrevious(group) {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    if (await runAction(REQUEST_MERGE_GROUP, { workId, episodeId, groupId: group.id })) await loadEpisode(false);
  }

  /** 按填写的单组最长时长重新分组；已有生成记录时先确认会被清除。 */
  async function regroup(secondsText) {
    const seconds = /^\d+$/.test(secondsText.trim()) ? Number(secondsText.trim()) : Number.NaN;
    if (!Number.isInteger(seconds)) {
      showMessage('单组最长时长必须是整数（秒）。', true);
      return;
    }
    if (view.groups.some((group) => group.jobs.length > 0)) {
      const confirmed = await aiUi.confirm({
        title: '重新分组',
        message: '重新分组会丢弃本集现有的镜头组，并清除各组已有的生成记录和失败原因（已保存的视频文件不会删除）。确认继续？',
        confirmText: '重新分组',
        cancelText: '取消',
        variant: 'danger'
      });
      if (!confirmed) return;
    }
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    if (await runAction(REQUEST_REGROUP, { workId, episodeId, maxSeconds: seconds })) await loadEpisode(false);
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

  /** 耗时文字：从提交到结束（进行中到现在）；还没提交给平台时为空。 */
  function formatElapsed(job) {
    if (!job.submittedAt) return '';
    const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
    const seconds = Math.max(0, Math.round((end - Date.parse(job.submittedAt)) / MS_PER_SECOND));
    return seconds < SECONDS_PER_MINUTE ? `${seconds} 秒` : `${Math.floor(seconds / SECONDS_PER_MINUTE)} 分 ${seconds % SECONDS_PER_MINUTE} 秒`;
  }

  /** 任务提交时的生成参数一行：模型、画幅、分辨率、时长、镜头数、声音、种子。 */
  function describeJobParams(job) {
    const { params } = job;
    return [
      job.modelName,
      params.aspectRatio,
      params.resolution,
      params.durationSeconds === null ? '' : `${params.durationSeconds} 秒`,
      `${job.shotCount} 个镜头`,
      AUDIO_MODE_LABELS[params.audioMode] || '',
      params.seed === null ? '' : `种子 ${params.seed}`
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** 一次任务的状态：状态文字、生成参数、时间、失败原因或结果信息、提醒与提交的提示词。 */
  function renderJob(job) {
    const elapsed = formatElapsed(job);
    const parts = [
      aiUi.h(
        'div',
        { class: 'wb-job__head' },
        aiUi.h('span', { class: STATUS_CLASSES[job.status] || 'description', text: job.statusLabel }),
        aiUi.h('span', { class: 'description', text: `第 ${job.attempt} 次 · ${formatRelativeTime(job.finishedAt || job.createdAt)}` })
      ),
      aiUi.h('div', { class: 'description wb-job__params', text: describeJobParams(job) }),
      aiUi.h('div', {
        class: 'description',
        text: `提交于 ${new Date(job.createdAt).toLocaleString('zh-CN')}${elapsed ? ` · 耗时 ${elapsed}` : ''}`
      })
    ];
    if (job.failure) parts.push(renderFailure(job.failure));
    if (job.result) {
      const { durationSeconds, sizeBytes, hasAudio } = job.result;
      const info = [durationSeconds === null ? '' : `${durationSeconds} 秒`, formatSize(sizeBytes), hasAudio ? '有声' : '无声'].filter(Boolean);
      parts.push(
        aiUi.h(
          'div',
          { class: 'wb-result' },
          aiUi.h('span', { class: 'description', text: `结果：${info.join(' · ')}` }),
          aiUi.button({ text: '打开视频', compact: true, onClick: () => void openResult(job.result) }).element,
          aiUi.button({ text: '导出…', compact: true, ariaLabel: '导出视频到指定位置', onClick: () => void exportResult(job.result) }).element,
          aiUi.button({ text: '在文件夹中显示', compact: true, onClick: () => void revealResult(job.result) }).element
        )
      );
    }
    for (const warning of job.warnings) parts.push(aiUi.h('div', { class: 'description', text: `提醒：${warning}` }));
    parts.push(
      aiUi.h('details', { class: 'wb-history' }, aiUi.h('summary', { text: '提交的提示词' }), aiUi.h('div', { class: 'wb-prompt', text: job.prompt }))
    );
    return aiUi.h('div', { class: 'wb-job' }, parts);
  }

  /** 镜头组的生成状态：最新一次任务，更早的任务折叠在“历史”里。 */
  function renderGroupStatus(group) {
    if (group.jobs.length === 0) return aiUi.h('span', { class: 'description', text: '尚未生成' });
    const [latest, ...older] = group.jobs;
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

  /** 镜头组内容：标题（镜头数与总时长、超出模型上限的警告）、组内镜头列表、出场实体。 */
  function renderGroupContent(group) {
    const max = modelMaxSeconds();
    const lines = [
      aiUi.h(
        'div',
        { class: 'wb-group__title' },
        aiUi.h('strong', { text: `第 ${group.seq} 组` }),
        aiUi.h('span', { class: 'description', text: `${group.shots.length} 个镜头 · 共 ${group.totalSeconds} 秒` })
      )
    ];
    if (exceedsModel(group)) {
      lines.push(aiUi.h('div', { class: 'status-warning', text: `超过所选模型单次最长 ${max} 秒，请拆分这一组或换一个模型。` }));
    }
    const canSplit = group.jobs.length === 0;
    lines.push(
      aiUi.h(
        'ol',
        { class: 'wb-shots' },
        group.shots.map((shot, index) =>
          aiUi.h(
            'li',
            { class: 'wb-shot' },
            aiUi.h(
              'span',
              { class: 'wb-shot__text', attrs: { title: shot.action } },
              `${[`镜头 ${shot.seq}`, shot.shotSize, shot.sceneLabel, `${shot.durationSeconds} 秒`].filter(Boolean).join(' · ')}　${preview(shot.action)}`
            ),
            index > 0 && canSplit && !submitting.has(group.id)
              ? aiUi.button({ text: '从这里拆开', compact: true, ariaLabel: `在镜头 ${shot.seq} 之前拆开这一组`, onClick: () => void splitBefore(shot) }).element
              : null
          )
        )
      )
    );
    if (group.entities.length > 0) {
      lines.push(
        aiUi.h(
          'div',
          { class: 'wb-chips' },
          group.entities.map((entity) => aiUi.chip({ text: entity.bound ? entity.name : `${entity.name} · 未绑定资产` }))
        )
      );
    }
    return aiUi.h('div', { class: 'wb-group' }, lines);
  }

  /** 镜头组的操作：任务进行中显示“取消”，否则显示“生成”或“重新生成”；可并入上一组；始终可以编辑镜头。 */
  function renderGroupActions(group, index) {
    const active = group.jobs.find((job) => ACTIVE_STATUSES.includes(job.status));
    const canSubmit = view.canGenerate && paramsReady() && !submitting.has(group.id) && !exceedsModel(group);
    const buttons = [];
    if (active) {
      buttons.push(aiUi.button({ text: '取消', compact: true, variant: 'danger', ariaLabel: `取消第 ${group.seq} 组的任务`, onClick: () => void cancelJob(active) }));
    } else {
      const text = group.jobs.length === 0 ? '生成' : '重新生成';
      buttons.push(
        aiUi.button({ text, compact: true, variant: 'primary', disabled: !canSubmit, ariaLabel: `${text}第 ${group.seq} 组`, onClick: () => void submit([group]) })
      );
    }
    const previous = view.groups[index - 1];
    if (previous && group.jobs.length === 0 && previous.jobs.length === 0 && !submitting.has(group.id)) {
      buttons.push(aiUi.button({ text: '并入上一组', compact: true, ariaLabel: `把第 ${group.seq} 组并入上一组`, onClick: () => void mergeIntoPrevious(group) }));
    }
    buttons.push(aiUi.button({ text: '编辑镜头', compact: true, ariaLabel: `编辑第 ${group.seq} 组的镜头`, onClick: openStoryboard }));
    return buttons.map((button) => button.element);
  }

  const GROUP_COLUMNS = [
    { title: '镜头组', minWidth: 320, render: renderGroupContent },
    { title: '生成状态', minWidth: 260, render: renderGroupStatus },
    { title: '操作', type: 'actions', render: renderGroupActions }
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
    if (resolved && Object.keys(resolved.issues).length > 0) {
      notices.push(
        aiUi.h(
          'div',
          { class: 'wb-notice' },
          aiUi.h('span', { class: 'status-warning', text: `生成参数需要调整：${Object.values(resolved.issues).join('')}` }),
          aiUi.button({ text: '生成参数', compact: true, onClick: openProfile }).element
        )
      );
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

  /** 打开本集的实体绑定页。 */
  function openBindings() {
    aiBindings.open(parseEpisodeKey(episodeKey).episodeId);
  }

  /** 批量操作与重新分组：提交还没有结果也没有进行中任务的组；按填写的时长重新分组。 */
  function renderBatchBar() {
    const pending = view.groups.filter(
      (group) => !submitting.has(group.id) && !exceedsModel(group) && !group.jobs.some((job) => ACTIVE_STATUSES.includes(job.status) || job.status === 'succeeded')
    );
    const enabled = view.canGenerate && paramsReady() && pending.length > 0;
    const max = modelMaxSeconds();
    if (regroupSeconds === '') regroupSeconds = String(max !== null && max <= 120 ? max : view.groupMaxSeconds);
    const secondsInput = aiUi.textInput({ value: regroupSeconds, ariaLabel: '重新分组时每组最长（秒）', onChange: (value) => (regroupSeconds = value) });
    const regroupDisabled = view.groups.some(hasActiveJob);
    const unboundCount = new Set(view.groups.flatMap((group) => group.entities.filter((entity) => !entity.bound).map((entity) => entity.id))).size;
    return aiUi.h(
      'div',
      { class: 'wb-batch' },
      aiUi.button({
        text: `生成未完成的镜头组（${pending.length}）`,
        variant: 'primary',
        disabled: !enabled,
        onClick: () => void submit(pending)
      }).element,
      aiUi.button({ text: '查看分镜脚本', onClick: openStoryboard }).element,
      aiUi.button({ text: unboundCount > 0 ? `实体绑定（${unboundCount} 个未绑定）` : '实体绑定', onClick: openBindings }).element,
      aiUi.h(
        'div',
        { class: 'wb-regroup' },
        aiUi.h('span', { class: 'description', text: '每组最长' }),
        aiUi.h('div', { class: 'wb-regroup__input' }, secondsInput.element),
        aiUi.h('span', { class: 'description', text: '秒' }),
        aiUi.button({ text: '重新分组', disabled: regroupDisabled, onClick: () => void regroup(secondsInput.getValue()) }).element
      )
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
      view.groups.length === 0 ? renderState('这一集没有镜头。') : aiUi.table({ columns: GROUP_COLUMNS, rows: view.groups, ariaLabel: '镜头组' }).element
    );
  }

  /** 加载当前集的视图。 */
  async function loadEpisode(showLoading) {
    if (!catalog || episodeKey === '') {
      view = null;
      profile = null;
      updateResolved();
      isLoading = false;
      renderToolbar();
      render();
      return;
    }
    if (showLoading) {
      isLoading = true;
      render();
    }
    loadError = '';
    try {
      const target = parseEpisodeKey(episodeKey);
      [view, profile] = await Promise.all([window.hostBridge.request(REQUEST_EPISODE, target), window.hostBridge.request(REQUEST_PROFILE, target)]);
      updateResolved();
    } catch (error) {
      loadError = errorText(error);
    }
    isLoading = false;
    renderToolbar();
    render();
    aiProfile.refresh();
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
      normalizeEpisodeKey();
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
    refreshTimer = window.setTimeout(() => {
      void loadAll(false);
      void aiBindings.refresh();
    }, REFRESH_DELAY_MS);
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
