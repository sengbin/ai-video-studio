// ------------------------------------------------------------------------
// 名称：workbench.js
// 说明：生成工作台页脚本：选择作品的一集，按“本集 → 作品 → 项目默认”的生成参数按镜头组提交生成（一组一次生成一个多镜头视频）；左栏列出镜头组（状态徽标，选中组展开镜头），中栏显示选中组的镜头、总时长、任务状态与历史，底部可折叠的队列列出全部任务，失败时显示平台返回的具体原因；支持重新分组、拆分与合并镜头组、取消、编辑镜头后再次生成、打开结果视频、在结果版本之间切换采用和对比。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求与事件名称与 src/app/pages/workbench-handlers.ts 一致；“编辑镜头”“确认分镜脚本”复用 stage/stage.js 的产出层（aiStage）；右栏检查器的页签容器由 workbench/inspector.js（aiInspector）提供，其中“绑定”面板由 workbench/bindings.js（aiBindings）提供，“参数”面板与生效参数的合并由 workbench/profile.js（aiProfile）提供，“提交”面板由 workbench/submit-panel.js（aiSubmit）提供，“结果版本”弹出页由 workbench/versions.js（aiVersions）提供，“上一组尾帧作首帧”的尾帧截取由 workbench/tail-frames.js（aiTailFrames）提供；依赖 shared/page-format.js（pageFormat）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_CATALOG = 'workbench.catalog';
  const REQUEST_EPISODE = 'workbench.episode';
  const REQUEST_PROFILE = 'workbench.profile';
  const REQUEST_SAVE_PROFILE = 'workbench.saveProfile';
  const REQUEST_SAVE_GROUP_PROFILE = 'workbench.saveGroupProfile';
  const REQUEST_SUBMIT = 'workbench.submit';
  const REQUEST_PREVIEW = 'workbench.preview';
  const REQUEST_REGROUP = 'workbench.regroup';
  const REQUEST_SPLIT_GROUP = 'workbench.splitGroup';
  const REQUEST_MERGE_GROUP = 'workbench.mergeGroup';
  const REQUEST_CANCEL = 'workbench.cancel';
  const REQUEST_SELECT_RESULT = 'workbench.selectResult';
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
  /** 状态前的图标，让状态不只靠颜色区分。 */
  const STATUS_ICONS = { waiting: '…', queued: '…', running: '●', succeeded: '✓', failed: '✕', canceled: '–' };
  /** 左栏宽度的范围与键盘调整的步长（像素）。 */
  const TREE_DEFAULT_WIDTH = 240;
  const TREE_MIN_WIDTH = 200;
  const TREE_MAX_WIDTH = 480;
  const TREE_KEY_STEP = 16;
  /** 右栏检查器宽度的范围（像素）。 */
  const INSPECTOR_DEFAULT_WIDTH = 340;
  const INSPECTOR_MIN_WIDTH = 300;
  const INSPECTOR_MAX_WIDTH = 560;
  /** 底部队列最多显示的任务数。 */
  const QUEUE_MAX_ROWS = 100;
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
  /** 当前选中的镜头组标识；没有选中或已不存在时按第一组显示。 */
  let selectedGroupId = null;
  /** 左栏宽度与是否折叠；队列区是否展开。 */
  let treeWidth = TREE_DEFAULT_WIDTH;
  let treeCollapsed = false;
  let queueOpen = false;
  let treeElement = null;
  /** 右栏检查器：宽度、是否折叠，以及页签容器和其中的两个面板（创建后一直保留）。 */
  let inspectorWidth = INSPECTOR_DEFAULT_WIDTH;
  let inspectorCollapsed = false;
  let inspector = null;
  let bindingsPanel = null;
  let profilePanel = null;
  let submitPanel = null;

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

  /** 展开检查器并切换到指定页签（绑定或参数）；窄屏时检查器在内容下方，滚动到可见位置。 */
  function openInspector(tabId) {
    if (inspectorCollapsed) {
      inspectorCollapsed = false;
      render();
    }
    inspector.show(tabId, true);
    inspector.element.scrollIntoView({ block: 'nearest' });
  }

  /** 参数面板里“仅选中的镜头组”对应的镜头组及其覆盖；没有选中时为 null。 */
  function profileGroup() {
    if (!view || view.groups.length === 0) return null;
    const group = view.groups[selectedGroupIndex()];
    return { id: group.id, seq: group.seq, overrides: group.overrides, totalSeconds: group.totalSeconds };
  }

  /** 一个镜头组的生效参数：本组覆盖优先于本集的生效值；还没有参数视图时为 null。 */
  function groupResolved(group) {
    return catalog && profile ? aiProfile.resolveForGroup(catalog, profile, group) : null;
  }

  /** 保存某一级的参数修改，成功后用返回的视图刷新工具栏、提交按钮和参数页；镜头组级的覆盖保存后重新读取本集视图。 */
  async function saveProfile(scope, changes) {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    if (scope === 'group') {
      const target = profileGroup();
      if (!target) return { ok: false, message: '请先选择一个镜头组。' };
      try {
        await window.hostBridge.request(REQUEST_SAVE_GROUP_PROFILE, { workId, episodeId, groupId: target.id, changes });
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
      await loadEpisode(false);
      return { ok: true };
    }
    try {
      profile = await window.hostBridge.request(REQUEST_SAVE_PROFILE, { scope, workId, episodeId, changes });
    } catch (error) {
      return { ok: false, message: errorText(error) };
    }
    updateResolved();
    renderToolbar();
    render();
    profilePanel.refresh();
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
      aiUi.button({ text: '生成参数', onClick: () => openInspector('profile') }).element
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

  /** 弹出分镜脚本产出层并定位到一个镜头组的第一个镜头。 */
  function editGroupShots(group) {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    aiStage.open(workId, STAGE_STORYBOARD, episodeId, group.shots.length > 0 ? group.shots[0].id : null);
  }

  function hasActiveJob(group) {
    return group.jobs.some((job) => ACTIVE_STATUSES.includes(job.status));
  }

  /** 这一组有结果视频的任务数。 */
  function resultCount(group) {
    return group.jobs.filter((job) => job.result).length;
  }

  /** 所选模型单次最长时长；没有上限信息时为 null。 */
  function modelMaxSeconds() {
    const model = selectedModel();
    return model ? model.maxGroupSeconds : null;
  }

  /** 这一组使用的模型单次最长时长（含本组覆盖的模型）；没有上限信息时为 null。 */
  function groupModelMaxSeconds(group) {
    const resolvedGroup = groupResolved(group);
    return resolvedGroup && resolvedGroup.model ? resolvedGroup.model.maxGroupSeconds : modelMaxSeconds();
  }

  /** 这一组是否超过它所用模型的单次最长时长。 */
  function exceedsModel(group) {
    const max = groupModelMaxSeconds(group);
    return max !== null && group.totalSeconds > max;
  }

  /** 这一组的生效参数是否可用于提交：有可用模型且各参数都在模型支持的范围内。 */
  function groupParamsReady(group) {
    const resolvedGroup = groupResolved(group);
    return Boolean(resolvedGroup && resolvedGroup.model) && Object.keys(resolvedGroup.issues).length === 0;
  }

  /** 本组覆盖了哪些参数，一行文字；没有覆盖为空串。 */
  function describeOverrides(group) {
    const { overrides } = group;
    const labels = { modelId: '模型', aspectRatio: '画幅', resolution: '分辨率', audioMode: '声音', audioElements: '声音内容', seed: '种子', durationSeconds: '生成时长' };
    const parts = Object.keys(labels)
      .filter((field) => overrides[field] !== null)
      .map((field) => {
        const value = overrides[field];
        if (field === 'modelId') {
          const model = catalog && catalog.models.find((item) => item.id === value);
          return `${labels[field]}：${model ? model.displayName : '（不可用）'}`;
        }
        if (field === 'audioElements') return `${labels[field]}：${aiProfile.describeElements(value)}`;
        if (field === 'durationSeconds') return `${labels[field]}：${value} 秒`;
        return `${labels[field]}：${field === 'audioMode' ? AUDIO_MODE_LABELS[value] || value : value}`;
      });
    return parts.join(' · ');
  }

  /** 提交与预览共用的请求内容：作品、集、镜头组与生效的生成参数。 */
  function submitPayload(groupIds) {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    return {
      workId,
      episodeId,
      groupIds,
      params: {
        modelId: Number(resolved.values.modelId),
        aspectRatio: resolved.values.aspectRatio,
        resolution: resolved.values.resolution,
        audioMode: resolved.values.audioMode,
        audioElements: resolved.values.audioElements,
        seed: resolved.values.seed
      }
    };
  }

  /** 提交镜头组；返回提交结果（已提交的组与被拒绝的原因），请求失败时返回 undefined。 */
  async function submit(groups) {
    if (!view || groups.length === 0) return undefined;
    groups.forEach((group) => submitting.add(group.id));
    render();
    const result = await runAction(REQUEST_SUBMIT, submitPayload(groups.map((group) => group.id)));
    groups.forEach((group) => submitting.delete(group.id));
    // 提交结果、被拒绝的原因和提醒由宿主在 VS Code 右下角通知，页面只刷新状态。
    await loadEpisode(false);
    return result;
  }

  /** 从检查器的“提交”页签提交：成功后展开底部队列并定位到第一个新任务所在的组。 */
  async function submitFromInspector(groupIds) {
    const result = await submit(view.groups.filter((group) => groupIds.includes(group.id)));
    if (result && result.submitted.length > 0) {
      queueOpen = true;
      selectedGroupId = result.submitted[0].groupId;
      render();
    }
  }

  /** 还没有结果、没有进行中任务，且没有超过所选模型单次最长时长的镜头组。 */
  function isPendingGroup(group) {
    return !submitting.has(group.id) && !exceedsModel(group) && !group.jobs.some((job) => ACTIVE_STATUSES.includes(job.status) || job.status === 'succeeded');
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

  /** 在页面内的播放器里播放结果视频。 */
  function playResult(result, title) {
    aiPlayer.open({ resultId: result.id, title, hasAudio: result.hasAudio });
  }

  /** 导出结果视频：宿主弹出“另存为”对话框，完成后在右下角通知。 */
  async function exportResult(result) {
    await runAction(REQUEST_EXPORT_RESULT, { resultId: result.id });
  }

  async function revealResult(result) {
    await runAction(REQUEST_REVEAL_RESULT, { resultId: result.id });
  }

  /** 采用一个结果版本；下一组采用的视频是接在这一组尾帧之后生成的，先征求确认。 */
  async function selectResult(result, groupId) {
    const index = view.groups.findIndex((group) => group.id === groupId);
    const next = view.groups[index + 1];
    const dependsOnTail = next && next.jobs.some((job) => job.result && job.result.isSelected && job.usesPreviousTail);
    if (dependsOnTail) {
      const confirmed = await aiUi.confirm({
        title: '采用此版本',
        message: `第 ${next.seq} 组采用的视频是接在这一组当前采用版本的尾帧之后生成的。改用其他版本后这两组的画面可能不连贯，需要重新生成第 ${next.seq} 组（不会自动重做）。确认采用？`,
        confirmText: '采用',
        cancelText: '取消'
      });
      if (!confirmed) return { ok: false, cancelled: true };
    }
    try {
      await window.hostBridge.request(REQUEST_SELECT_RESULT, { resultId: result.id });
    } catch (error) {
      return { ok: false, message: errorText(error) };
    }
    await loadEpisode(false);
    return { ok: true };
  }

  /** 结果视频的信息一行：时长、大小、是否有声。 */
  function describeResult(result) {
    const { durationSeconds, sizeBytes, hasAudio } = result;
    return [durationSeconds === null ? '' : `${durationSeconds} 秒`, formatSize(sizeBytes), hasAudio ? '有声' : '无声'].filter(Boolean).join(' · ');
  }

  /** 弹出这一组的结果版本页：采用、打开、导出、对比。 */
  function openVersions(group) {
    aiVersions.open(group.id, {
      getState: () => ({ view }),
      select: selectResult,
      describeParams: describeJobParams,
      describeResult,
      describeFields: describeJobFields,
      openResult,
      exportResult,
      revealResult
    });
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
      job.usesPreviousTail ? '首帧：上一组尾帧' : '',
      AUDIO_MODE_LABELS[params.audioMode] || '',
      params.audioMode === 'native' && params.audioElements ? aiProfile.describeElements(params.audioElements) : '',
      params.seed === null ? '' : `种子 ${params.seed}`
    ]
      .filter(Boolean)
      .join(' · ');
  }

  /** 任务的对比条目：提交时的参数、结果信息和提示词，两个任务的条目顺序一致。 */
  function describeJobFields(job) {
    const { params } = job;
    const orNone = (value) => (value === null || value === undefined || value === '' ? '（未指定）' : String(value));
    return [
      { label: '模型', value: orNone(job.modelName) },
      { label: '画幅', value: orNone(params.aspectRatio) },
      { label: '分辨率', value: orNone(params.resolution) },
      { label: '整组时长', value: params.durationSeconds === null ? '（未指定）' : `${params.durationSeconds} 秒` },
      { label: '镜头数', value: String(job.shotCount) },
      { label: '首帧', value: job.usesPreviousTail ? '上一组尾帧' : '无' },
      { label: '声音', value: AUDIO_MODE_LABELS[params.audioMode] || orNone(params.audioMode) },
      { label: '声音内容', value: params.audioElements ? aiProfile.describeElements(params.audioElements) : '（未指定）' },
      { label: '种子', value: orNone(params.seed) },
      { label: '结果', value: describeResult(job.result) },
      { label: '提示词', value: job.prompt, long: true }
    ];
  }

  /** 一次任务的状态：状态文字、生成参数、时间、失败原因或结果信息、提醒与提交的提示词；showAdopted 为 true（这一组有多个版本）时标出采用的那个。 */
  function renderJob(job, group, showAdopted) {
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
    if (job.waitNote) parts.push(aiUi.h('div', { class: 'status-warning', text: job.waitNote }));
    if (job.failure) parts.push(renderFailure(job.failure));
    if (job.result) {
      parts.push(
        aiUi.h(
          'div',
          { class: 'wb-result' },
          aiUi.h('span', { class: 'description', text: `结果：${describeResult(job.result)}` }),
          showAdopted && job.result.isSelected ? aiUi.chip({ text: '已采用' }) : null,
          aiUi.button({ text: '播放', compact: true, variant: 'primary', ariaLabel: `播放第 ${group.seq} 组第 ${job.attempt} 次的视频`, onClick: () => playResult(job.result, `第 ${group.seq} 组 · 第 ${job.attempt} 次`) }).element,
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
    const showAdopted = resultCount(group) > 1;
    return aiUi.h(
      'div',
      {},
      group.staleNote ? aiUi.h('div', { class: 'status-warning wb-stale', text: group.staleNote }) : null,
      renderJob(latest, group, showAdopted),
      older.length > 0
        ? aiUi.h(
            'details',
            { class: 'wb-history' },
            aiUi.h('summary', { text: `历史记录（${older.length} 次）` }),
            older.map((job) => renderJob(job, group, showAdopted))
          )
        : null
    );
  }

  /** 镜头组内容：标题（镜头数与总时长、超出模型上限的警告）、组内镜头列表、出场实体。 */
  function renderGroupContent(group) {
    const max = groupModelMaxSeconds(group);
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
    const canSubmit = view.canGenerate && paramsReady() && groupParamsReady(group) && !submitting.has(group.id) && !exceedsModel(group);
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
    buttons.push(aiUi.button({ text: '编辑镜头', compact: true, ariaLabel: `编辑第 ${group.seq} 组的镜头`, onClick: () => editGroupShots(group) }));
    if (resultCount(group) > 1) {
      buttons.push(aiUi.button({ text: `结果版本（${resultCount(group)}）`, compact: true, ariaLabel: `查看第 ${group.seq} 组的结果版本`, onClick: () => openVersions(group) }));
    }
    return buttons.map((button) => button.element);
  }

  /** 镜头组状态：最新一次任务的状态；还没有任务时，有未绑定资产的实体为“待绑定”，否则为“可生成”。图标让状态不只靠颜色区分。 */
  function groupStatus(group) {
    const [latest] = group.jobs;
    if (latest) {
      return { text: `${STATUS_ICONS[latest.status] || ''} ${latest.statusLabel}`.trim(), className: STATUS_CLASSES[latest.status] || 'description' };
    }
    if (group.entities.some((entity) => !entity.bound)) return { text: '! 待绑定', className: 'status-warning' };
    return { text: '○ 可生成', className: 'description' };
  }

  /** 当前选中的镜头组及其序号；没有选中（或已不存在）时取第一组。 */
  function selectedGroupIndex() {
    const index = view ? view.groups.findIndex((group) => group.id === selectedGroupId) : -1;
    return index >= 0 ? index : 0;
  }

  /** 选中一个镜头组并刷新页面。 */
  function selectGroup(group) {
    selectedGroupId = group.id;
    render();
  }

  /** 设置左栏宽度（限制在最小与最大宽度之间）。 */
  function setTreeWidth(width) {
    treeWidth = Math.min(TREE_MAX_WIDTH, Math.max(TREE_MIN_WIDTH, Math.round(width)));
    if (treeElement) treeElement.style.width = `${treeWidth}px`;
    return treeWidth;
  }

  /** 设置右栏检查器宽度（限制在最小与最大宽度之间）。 */
  function setInspectorWidth(width) {
    inspectorWidth = Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(width)));
    if (inspector) inspector.element.style.width = `${inspectorWidth}px`;
    return inspectorWidth;
  }

  /**
   * 栏与相邻栏之间的分隔条：可拖动，也可用左右方向键调整宽度。
   * @param {{ label: string, min: number, max: number, getWidth: () => number, setWidth: (width: number) => number, direction: 1 | -1 }} config
   *   direction 为 1 表示栏在分隔条左侧（向右拖变宽），-1 表示栏在右侧（向左拖变宽）。
   */
  function createSplitter(config) {
    const { label, min, max, getWidth, setWidth, direction } = config;
    const element = aiUi.h('div', {
      class: 'wb-splitter',
      attrs: { role: 'separator', 'aria-orientation': 'vertical', 'aria-label': label, 'aria-valuemin': min, 'aria-valuemax': max, 'aria-valuenow': getWidth(), tabindex: 0 },
      on: {
        pointerdown: (event) => {
          const start = getWidth();
          aiUi.trackPointer(element, event, (deltaX) => element.setAttribute('aria-valuenow', String(setWidth(start + direction * deltaX))));
        },
        keydown: (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          const step = (event.key === 'ArrowRight' ? 1 : -1) * direction * TREE_KEY_STEP;
          element.setAttribute('aria-valuenow', String(setWidth(getWidth() + step)));
        }
      }
    });
    return element;
  }

  /** 左栏：镜头组列表，选中的组展开列出组内镜头；可折叠为窄条。 */
  function renderTree(selectedId) {
    const collapseButton = aiUi.button({
      text: treeCollapsed ? '›' : '‹',
      compact: true,
      ariaLabel: treeCollapsed ? '展开镜头组栏' : '折叠镜头组栏',
      onClick: () => {
        treeCollapsed = !treeCollapsed;
        render();
      }
    });
    if (treeCollapsed) {
      treeElement = aiUi.h('nav', { class: 'wb-tree wb-tree--collapsed', attrs: { 'aria-label': '镜头组' } }, collapseButton.element);
      return treeElement;
    }
    const items = view.groups.map((group) => {
      const isSelected = group.id === selectedId;
      const status = groupStatus(group);
      const shotsId = `wb-tree-shots-${group.id}`;
      return aiUi.h(
        'li',
        { class: 'wb-tree__group' },
        aiUi.h(
          'button',
          {
            class: `wb-tree__item${isSelected ? ' wb-tree__item--selected' : ''}`,
            attrs: { type: 'button', 'aria-current': isSelected ? 'true' : undefined, 'aria-expanded': String(isSelected), 'aria-controls': shotsId },
            on: { click: () => selectGroup(group) }
          },
          aiUi.h('span', { class: 'wb-tree__title' }, aiUi.h('strong', { text: `第 ${group.seq} 组` }), aiUi.h('span', { class: 'description', text: `${group.totalSeconds} 秒` })),
          aiUi.h('span', { class: `wb-tree__status ${status.className}`, text: status.text })
        ),
        isSelected
          ? aiUi.h(
              'ul',
              { class: 'wb-tree__shots', attrs: { id: shotsId } },
              group.shots.map((shot) =>
                aiUi.h('li', { class: 'wb-tree__shot', attrs: { title: shot.action } }, [`镜头 ${shot.seq}`, shot.shotSize, `${shot.durationSeconds} 秒`].filter(Boolean).join(' · '))
              )
            )
          : null
      );
    });
    treeElement = aiUi.h(
      'nav',
      { class: 'wb-tree', attrs: { 'aria-label': '镜头组' } },
      aiUi.h('div', { class: 'wb-tree__head' }, aiUi.h('strong', { text: `镜头组（${view.groups.length}）` }), collapseButton.element),
      aiUi.h('ul', { class: 'wb-tree__list' }, items)
    );
    treeElement.style.width = `${treeWidth}px`;
    return treeElement;
  }

  /** 窄屏时代替左栏的镜头组下拉。 */
  function renderGroupSelect(selectedId) {
    const select = aiUi.select({
      options: view.groups.map((group) => ({ value: String(group.id), label: `第 ${group.seq} 组 · ${group.totalSeconds} 秒 · ${groupStatus(group).text}` })),
      value: String(selectedId),
      allowEmpty: false,
      ariaLabel: '选择镜头组',
      onChange: (value) => {
        selectedGroupId = Number(value);
        render();
      }
    });
    return aiUi.h('div', { class: 'wb-group-select' }, select.element);
  }

  /** 本组覆盖的参数与修改入口；参数不可用时给出警告。 */
  function renderGroupParams(group) {
    const overrides = describeOverrides(group);
    const resolvedGroup = groupResolved(group);
    const issues = resolvedGroup ? Object.values(resolvedGroup.issues) : [];
    return aiUi.h(
      'div',
      { class: 'wb-group-params' },
      aiUi.h('span', { class: 'description', text: overrides === '' ? '本组参数：沿用本集设置' : `本组参数覆盖：${overrides}` }),
      issues.length === 0 ? null : aiUi.h('span', { class: 'status-warning', text: `本组参数需要调整：${issues.join('')}` }),
      aiUi.button({
        text: '修改本组参数',
        compact: true,
        onClick: () => {
          profilePanel.setScope('group');
          openInspector('profile');
        }
      }).element
    );
  }

  /** 中栏：选中镜头组的内容、操作与生成状态。 */
  function renderDetail(group, index) {
    return aiUi.h(
      'section',
      { class: 'wb-detail', attrs: { 'aria-label': `第 ${group.seq} 组` } },
      renderGroupContent(group),
      renderGroupParams(group),
      aiUi.h('div', { class: 'wb-detail__actions' }, renderGroupActions(group, index)),
      aiUi.h('h3', { class: 'wb-detail__title', text: '生成状态' }),
      renderGroupStatus(group)
    );
  }

  /** 队列里的全部任务，最新的在前，最多显示一定数量。 */
  function queueRows() {
    return view.groups
      .flatMap((group) => group.jobs.map((job, order) => ({ job, group, isLatest: order === 0 })))
      .sort((left, right) => Date.parse(right.job.createdAt) - Date.parse(left.job.createdAt) || right.job.id - left.job.id)
      .slice(0, QUEUE_MAX_ROWS);
  }

  /** 队列摘要：进行中的任务数、最新任务失败的组数、已有结果的组数。 */
  function queueSummary() {
    const active = view.groups.reduce((sum, group) => sum + group.jobs.filter((job) => ACTIVE_STATUSES.includes(job.status)).length, 0);
    const failed = view.groups.filter((group) => group.jobs[0] && group.jobs[0].status === 'failed').length;
    const done = view.groups.filter((group) => resultCount(group) > 0).length;
    return `生成中 ${active} · 失败 ${failed} · 已完成 ${done}（共 ${view.groups.length} 组）`;
  }

  /** 底部队列与结果：默认折叠为一行摘要，展开后列出每个任务。 */
  function renderQueue() {
    const panelId = 'wb-queue-panel';
    const header = aiUi.h(
      'button',
      {
        class: 'wb-queue__toggle',
        attrs: { type: 'button', 'aria-expanded': String(queueOpen), 'aria-controls': panelId },
        on: {
          click: () => {
            queueOpen = !queueOpen;
            render();
          }
        }
      },
      aiUi.h('span', { class: 'wb-queue__icon', text: queueOpen ? '▾' : '▸', attrs: { 'aria-hidden': 'true' } }),
      aiUi.h('strong', { text: '队列与结果' }),
      aiUi.h('span', { class: 'description', text: queueSummary() })
    );
    const rows = queueRows();
    const columns = [
      {
        title: '镜头组',
        nowrap: true,
        render: ({ group }) => aiUi.button({ text: `第 ${group.seq} 组`, compact: true, ariaLabel: `定位到第 ${group.seq} 组`, onClick: () => selectGroup(group) }).element
      },
      { title: '模型', render: ({ job }) => job.modelName },
      {
        title: '状态',
        minWidth: 160,
        render: ({ job }) =>
          aiUi.h(
            'div',
            {},
            aiUi.h('span', { class: STATUS_CLASSES[job.status] || 'description', text: `${STATUS_ICONS[job.status] || ''} ${job.statusLabel}`.trim() }),
            job.failure ? aiUi.h('div', { class: 'description wb-queue__failure', text: job.failure.label, attrs: { title: job.failure.message } }) : null,
            job.waitNote ? aiUi.h('div', { class: 'status-warning', text: job.waitNote }) : null
          )
      },
      { title: '耗时', nowrap: true, muted: true, render: ({ job }) => formatElapsed(job) },
      { title: '尝试', type: 'number', render: ({ job }) => job.attempt },
      {
        title: '操作',
        type: 'actions',
        render: ({ job, group, isLatest }) => {
          const buttons = [];
          if (ACTIVE_STATUSES.includes(job.status)) {
            buttons.push(aiUi.button({ text: '取消', compact: true, variant: 'danger', ariaLabel: `取消第 ${group.seq} 组的任务`, onClick: () => void cancelJob(job) }));
          }
          if (isLatest && (job.status === 'failed' || job.status === 'canceled')) {
            const canRetry = view.canGenerate && paramsReady() && groupParamsReady(group) && !submitting.has(group.id) && !exceedsModel(group);
            buttons.push(aiUi.button({ text: '重试', compact: true, disabled: !canRetry, ariaLabel: `重新生成第 ${group.seq} 组`, onClick: () => void submit([group]) }));
          }
          if (job.result) {
            buttons.push(aiUi.button({ text: '播放', compact: true, variant: 'primary', ariaLabel: `播放第 ${group.seq} 组第 ${job.attempt} 次的视频`, onClick: () => playResult(job.result, `第 ${group.seq} 组 · 第 ${job.attempt} 次`) }));
            buttons.push(aiUi.button({ text: '打开视频', compact: true, ariaLabel: `打开第 ${group.seq} 组第 ${job.attempt} 次的视频`, onClick: () => void openResult(job.result) }));
          }
          return buttons.map((button) => button.element);
        }
      }
    ];
    return aiUi.h(
      'section',
      { class: 'wb-queue', attrs: { 'aria-label': '队列与结果' } },
      header,
      aiUi.h(
        'div',
        { class: 'wb-queue__panel', hidden: !queueOpen, attrs: { id: panelId } },
        rows.length === 0 ? aiUi.h('p', { class: 'description', text: '还没有提交过生成任务。' }) : aiUi.table({ columns, rows, ariaLabel: '生成任务' }).element
      )
    );
  }

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
          aiUi.button({ text: '生成参数', compact: true, onClick: () => openInspector('profile') }).element
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

  /** 批量操作与重新分组：提交还没有结果也没有进行中任务的组；按填写的时长重新分组。 */
  function renderBatchBar() {
    const pending = view.groups.filter(isPendingGroup);
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
        text: `提交未完成的镜头组（${pending.length}）…`,
        variant: 'primary',
        disabled: !enabled,
        onClick: () => {
          submitPanel.select(pending.map((group) => group.id));
          openInspector('submit');
        }
      }).element,
      aiUi.button({ text: '查看分镜脚本', onClick: openStoryboard }).element,
      aiUi.button({ text: unboundCount > 0 ? `实体绑定（${unboundCount} 个未绑定）` : '实体绑定', onClick: () => openInspector('bindings') }).element,
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
    const treeScroll = treeElement && treeElement.querySelector('.wb-tree__list') ? treeElement.querySelector('.wb-tree__list').scrollTop : 0;
    contentElement.textContent = '';
    treeElement = null;
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
    contentElement.append(renderBatchBar());
    if (view.groups.length === 0) {
      contentElement.append(renderState('这一集没有镜头。'));
      return;
    }
    const index = selectedGroupIndex();
    const group = view.groups[index];
    selectedGroupId = group.id;
    contentElement.append(
      aiUi.h(
        'div',
        { class: 'wb-layout' },
        renderTree(group.id),
        treeCollapsed ? null : createSplitter({ label: '调整镜头组栏宽度', min: TREE_MIN_WIDTH, max: TREE_MAX_WIDTH, getWidth: () => treeWidth, setWidth: setTreeWidth, direction: 1 }),
        aiUi.h('div', { class: 'wb-main' }, renderGroupSelect(group.id), renderDetail(group, index)),
        inspectorCollapsed ? null : createSplitter({ label: '调整检查器宽度', min: INSPECTOR_MIN_WIDTH, max: INSPECTOR_MAX_WIDTH, getWidth: () => inspectorWidth, setWidth: setInspectorWidth, direction: -1 }),
        renderInspectorColumn()
      ),
      renderQueue()
    );
    const list = treeElement && treeElement.querySelector('.wb-tree__list');
    if (list) list.scrollTop = treeScroll;
    updateInspectorLabels();
    profilePanel.refresh();
    submitPanel.refresh();
  }

  /** 右栏：展开时是检查器（宽度可调），折叠时是一个窄条和展开按钮。检查器元素创建后一直保留，只是每次重新挂到新的布局里。 */
  function renderInspectorColumn() {
    if (inspectorCollapsed) {
      return aiUi.h(
        'div',
        { class: 'wb-rail' },
        aiUi.button({
          text: '‹',
          compact: true,
          ariaLabel: '展开检查器',
          onClick: () => {
            inspectorCollapsed = false;
            render();
          }
        }).element
      );
    }
    inspector.element.style.width = `${inspectorWidth}px`;
    return inspector.element;
  }

  /** 页签文字带上状态：有未绑定的实体、生成参数需要调整时直接写在文字里。 */
  function updateInspectorLabels() {
    const unbound = view ? new Set(view.groups.flatMap((group) => group.entities.filter((entity) => !entity.bound).map((entity) => entity.id))).size : 0;
    inspector.setLabel('bindings', unbound > 0 ? `绑定（${unbound} 个未绑定）` : '绑定', unbound > 0);
    const hasIssues = Boolean(resolved && Object.keys(resolved.issues).length > 0);
    inspector.setLabel('profile', hasIssues ? '参数（需调整）' : '参数', hasIssues);
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
      bindingsPanel.setEpisode(null);
      profilePanel.refresh();
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
    bindingsPanel.setEpisode(episodeKey === '' ? null : parseEpisodeKey(episodeKey).episodeId);
    profilePanel.refresh();
    submitPanel.refresh();
    aiVersions.refresh();
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
    refreshTimer = window.setTimeout(async () => {
      await Promise.all([loadAll(false), bindingsPanel.refresh()]);
      void aiTailFrames.sync();
    }, REFRESH_DELAY_MS);
  }

  /** 渲染页面骨架：工具栏、操作结果、内容区。 */
  function renderPage() {
    toolbarElement = aiUi.h('div', { class: 'wb-toolbar' });
    document.getElementById('page-toolbar').append(toolbarElement);
    messageElement = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div');
    root.append(messageElement, contentElement);
    // 检查器的两个面板创建一次，之后只在页签之间切换显示。
    bindingsPanel = aiBindings.create();
    profilePanel = aiProfile.create({ getState: () => ({ catalog, profile, group: profileGroup() }), save: saveProfile });
    const collapseButton = aiUi.button({
      text: '›',
      compact: true,
      ariaLabel: '折叠检查器',
      onClick: () => {
        inspectorCollapsed = true;
        render();
      }
    });
    submitPanel = aiSubmit.create({
      getState: () => ({ view, resolved, episodeKey, busyGroupIds: submitting }),
      isVisible: () => Boolean(inspector) && inspector.getActive() === 'submit' && !inspectorCollapsed && inspector.element.isConnected,
      groupStatus,
      isSelectable: (group) => !hasActiveJob(group) && !submitting.has(group.id),
      isPending: isPendingGroup,
      summarize: () => (resolved ? aiProfile.summarize(resolved) : ''),
      openTab: openInspector,
      preview: (groupIds) => window.hostBridge.request(REQUEST_PREVIEW, submitPayload(groupIds)),
      submit: submitFromInspector
    });
    inspector = aiInspector.create({
      tabs: [
        { id: 'bindings', label: '绑定', build: () => bindingsPanel },
        { id: 'profile', label: '参数', build: () => profilePanel },
        { id: 'submit', label: '提交', build: () => submitPanel }
      ],
      initial: 'bindings',
      actions: [collapseButton.element]
    });
  }

  renderPage();
  window.hostBridge.onEvent(EVENT_CHANGED, scheduleRefresh);
  // 在“模型设置”里改了模型或密钥后切回本页，可用模型要随之更新。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleRefresh();
  });
  window.addEventListener('focus', scheduleRefresh);
  void loadAll(true).then(() => aiTailFrames.sync());
})();
