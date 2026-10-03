// ------------------------------------------------------------------------
// 名称：workbench.js
// 说明：生成工作台页脚本：顶部选择项目、作品与分集并显示当前生成配置；下面三栏——左栏镜头组列表（状态、镜头数与时长、重新分组），中栏选中镜头组的详情（镜头、出场实体概览、生成状态与结果），右栏三步流程（绑定素材、配置参数、检查并提交）；底部可折叠的队列列出全部任务，失败时显示平台返回的具体原因。页面不出现整页滚动条，各区域在内部滚动。支持重新分组、拆分与合并镜头组、取消、编辑镜头后再次生成、打开结果视频、在结果版本之间切换采用和对比。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：请求与事件名称与 src/app/pages/workbench-handlers.ts 一致；“编辑镜头”“确认分镜脚本”复用 stage/stage.js 的产出层（aiStage）；右栏步骤页签由 workbench/step-tabs.js（aiStepTabs）提供，其中“绑定素材”面板由 workbench/bindings.js（aiBindings）提供，“配置参数”面板与生效参数的合并由 workbench/profile.js（aiProfile）提供，“检查并提交”面板由 workbench/submit-panel.js（aiSubmit）提供，“结果版本”弹出页由 workbench/versions.js（aiVersions）提供（打开时另行请求该组全部历史成功版本），“上一组尾帧作首帧”的尾帧截取由 workbench/tail-frames.js（aiTailFrames）提供；依赖 shared/page-format.js（pageFormat）。
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
  const REQUEST_GROUP_VERSIONS = 'workbench.groupVersions';
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
  const AUDIO_MODE_LABELS = { native: '模型生成声音', none: '无声' };
  /** 状态前的图标，让状态不只靠颜色区分。 */
  const STATUS_ICONS = { waiting: '…', queued: '…', running: '●', succeeded: '✓', failed: '✕', canceled: '–' };
  /** 重绘前后需要保持滚动位置的区域：镜头组列表、详情、镜头列表、各步骤面板、队列。 */
  const SCROLL_SELECTORS = ['.wb-groups__list', '.wb-detail__body', '.wb-shots', '.wb-steps__panel', '.wb-queue__body'];
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
  /** 顶部上下文栏当前对应的选项标记，选项变化时才重建，避免后台刷新关闭用户打开的下拉。 */
  let contextKey = null;
  let contextElement = null;
  let messageElement = null;
  let contentElement = null;
  /** 当前选中的镜头组标识；没有选中或已不存在时按第一组显示。 */
  let selectedGroupId = null;
  /** 底部队列是否展开。 */
  let queueOpen = true;
  /** 右栏的步骤页签，以及其中三个步骤的面板（创建后一直保留）。 */
  let stepTabs = null;
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

  /** 可选的作品：只列有集的作品。 */
  function selectableWorks() {
    return catalog.works.filter((work) => work.episodes.length > 0);
  }

  /** 一集在下拉里的取值：“作品标识:集标识”。 */
  function episodeKeyOf(work, episode) {
    return `${work.id}:${episode.episodeId}`;
  }

  /** 一集在下拉里的文字：序号、标题与分镜脚本状态。 */
  function episodeLabel(episode) {
    return `第 ${episode.seq} 集${episode.title ? ` ${episode.title}` : ''}（${stageStatusLabel(episode.display)}）`;
  }

  /** 已选择的集不在清单里时（如被删除），改选第一个。 */
  function normalizeEpisodeKey() {
    if (!catalog) return;
    const keys = selectableWorks().flatMap((work) => work.episodes.map((episode) => episodeKeyOf(work, episode)));
    if (!keys.includes(episodeKey)) episodeKey = keys[0] || '';
  }

  /** 当前所选集所在的作品；没有选中任何集时为 undefined。 */
  function selectedWork() {
    if (!catalog || episodeKey === '') return undefined;
    const { workId } = parseEpisodeKey(episodeKey);
    return catalog.works.find((work) => work.id === workId);
  }

  /** 切换到另一集：先清空当前集的数据，再重新读取。 */
  function selectEpisode(key) {
    if (key === episodeKey) return;
    episodeKey = key;
    view = null;
    profile = null;
    updateResolved();
    isLoading = true;
    renderContext();
    render();
    void loadEpisode(false);
  }

  /** 切换项目或作品后，落到所选作品的第一集。 */
  function selectWork(work) {
    selectEpisode(episodeKeyOf(work, work.episodes[0]));
  }

  /** 顶部上下文栏里的一项：标签加内容。 */
  function renderContextItem(label, content) {
    return aiUi.h('div', { class: 'wb-context__item' }, aiUi.h('span', { class: 'wb-context__label', text: label }), content);
  }

  /** 顶部上下文栏：项目、作品、分集三个下拉和当前生效的生成配置；内容没有变化时保持原样，避免后台刷新关闭用户打开的下拉。 */
  function renderContext() {
    const work = selectedWork();
    const summary = resolved ? aiProfile.summarize(resolved) : '';
    const key = JSON.stringify([
      catalog && catalog.works.map((item) => [item.id, item.name, item.projectName, item.episodes.map((episode) => [episode.episodeId, episode.seq, episode.title, episode.display])]),
      episodeKey,
      summary
    ]);
    if (key === contextKey) return;
    contextKey = key;
    contextElement.textContent = '';
    contextElement.hidden = !work;
    if (!work) return;

    const works = selectableWorks();
    const projectNames = [...new Set(works.map((item) => item.projectName))];
    const projectSelect = aiUi.select({
      options: projectNames.map((name) => ({ value: name, label: name })),
      value: work.projectName,
      allowEmpty: false,
      ariaLabel: '选择项目',
      onChange: (name) => selectWork(works.find((item) => item.projectName === name))
    });
    const workSelect = aiUi.select({
      options: works.filter((item) => item.projectName === work.projectName).map((item) => ({ value: String(item.id), label: item.name })),
      value: String(work.id),
      allowEmpty: false,
      ariaLabel: '选择作品',
      onChange: (id) => selectWork(works.find((item) => String(item.id) === id))
    });
    const episodeSelect = aiUi.select({
      options: work.episodes.map((episode) => ({ value: episodeKeyOf(work, episode), label: episodeLabel(episode) })),
      value: episodeKey,
      allowEmpty: false,
      ariaLabel: '选择分集',
      onChange: selectEpisode
    });
    contextElement.append(
      renderContextItem('项目', projectSelect.element),
      renderContextItem('作品', workSelect.element),
      renderContextItem('分集', episodeSelect.element),
      renderContextItem('当前生成配置（在“配置参数”步骤中修改）', aiUi.h('div', { class: 'wb-context__summary', text: summary || '—', attrs: { title: summary } }))
    );
  }

  /** 步骤页签的副文字与状态：绑定步骤看所选镜头组未绑定的实体数，参数步骤看生效参数是否可用，提交步骤看待提交的镜头组数。 */
  function updateStepTabs() {
    if (!view || view.groups.length === 0) {
      for (const id of ['bindings', 'profile', 'submit']) stepTabs.setStatus(id, { note: '' });
      return;
    }
    const selected = view.groups[selectedGroupIndex()];
    stepTabs.setContext(`第 ${selected.seq} 组`);
    bindingsPanel.setEntities(selected.entities.map((entity) => entity.id));
    const unbound = selected.entities.filter((entity) => !entity.bound).length;
    stepTabs.setStatus('bindings', unbound > 0 ? { note: `${unbound} 项未绑定` } : { note: '全部已绑定', state: 'done' });

    if (!resolved || !resolved.model) {
      stepTabs.setStatus('profile', { note: '无可用模型' });
    } else if (Object.keys(resolved.issues).length > 0) {
      stepTabs.setStatus('profile', { note: '需调整' });
    } else {
      const { aspectRatio, resolution } = resolved.values;
      stepTabs.setStatus('profile', { note: [aspectRatio, resolution].filter(Boolean).join(' · ') || resolved.model.displayName, state: 'done' });
    }

    const pending = view.groups.filter(isPendingGroup).length;
    if (view.blockReason) stepTabs.setStatus('submit', { note: '分镜脚本未确认' });
    else if (pending > 0) stepTabs.setStatus('submit', { note: `${pending} 组待提交` });
    else stepTabs.setStatus('submit', { note: '没有待提交', state: 'done' });
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

  /** 参数面板里“本镜头组”对应的镜头组及其覆盖；没有选中时为 null。 */
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
    renderContext();
    render();
    profilePanel.refresh();
    return { ok: true };
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
        seed: resolved.values.seed,
        negativeList: resolved.values.negativeList,
        promptExtend: resolved.values.promptExtend
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

  /** 从“检查并提交”步骤提交所选的镜头组；至少有一组已入队时展开队列并定位到第一个已提交的组，返回 true。 */
  async function submitSelected(groupIds) {
    const result = await submit(view.groups.filter((group) => groupIds.includes(group.id)));
    if (result && result.submitted.length > 0) {
      queueOpen = true;
      selectedGroupId = result.submitted[0].groupId;
      render();
      return true;
    }
    return false;
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
    if (result && result.remoteCancelError) {
      showMessage(`已停止等待这个任务的结果，但通知平台取消失败（${result.remoteCancelError}）。平台上的任务可能仍在继续并计费，请到平台控制台确认。`, true);
    } else if (result && isRunning && !result.remoteCanceled) {
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

  /** 向宿主读取这一组全部历史成功版本（工作台列表只带最近若干条任务）；失败时返回原因。 */
  async function loadGroupVersions(groupId) {
    const { workId, episodeId } = parseEpisodeKey(episodeKey);
    try {
      return { ok: true, jobs: await window.hostBridge.request(REQUEST_GROUP_VERSIONS, { workId, episodeId, groupId }) };
    } catch (error) {
      return { ok: false, message: errorText(error) };
    }
  }

  /** 弹出这一组的结果版本页：采用、打开、导出、对比。 */
  function openVersions(group) {
    aiVersions.open(group.id, {
      getState: () => ({ view }),
      loadVersions: loadGroupVersions,
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

  /** 任务的首帧来源说明：上一组尾帧、指定图片或无。 */
  function firstFrameLabel(job) {
    if (job.usesPreviousTail) return '上一组尾帧';
    return job.usesFirstFrameImage ? '指定图片' : '无';
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
      firstFrameLabel(job) === '无' ? '' : `首帧：${firstFrameLabel(job)}`,
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
      { label: '首帧', value: firstFrameLabel(job) },
      { label: '声音', value: AUDIO_MODE_LABELS[params.audioMode] || orNone(params.audioMode) },
      { label: '声音内容', value: params.audioElements ? aiProfile.describeElements(params.audioElements) : '（未指定）' },
      { label: '种子', value: orNone(params.seed) },
      { label: '结果', value: describeResult(job.result) },
      { label: '提示词格式', value: `第 ${job.promptFormat} 版` },
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

  /** 左栏：镜头组列表（序号、状态、镜头数与总时长），底部是镜头总数与重新分组。 */
  function renderGroupsPanel(selectedId) {
    const items = view.groups.map((group) => {
      const isSelected = group.id === selectedId;
      const status = groupStatus(group);
      return aiUi.h(
        'li',
        {},
        aiUi.h(
          'button',
          {
            class: `wb-group-item${isSelected ? ' wb-group-item--selected' : ''}`,
            attrs: { type: 'button', 'aria-current': isSelected ? 'true' : undefined },
            on: { click: () => selectGroup(group) }
          },
          aiUi.h('span', { class: 'wb-group-item__name', text: `第 ${group.seq} 组` }),
          aiUi.h('span', { class: `wb-group-item__status ${status.className}`, text: status.text }),
          aiUi.h('span', { class: 'wb-group-item__meta description', text: `${group.shots.length} 个镜头 · ${group.totalSeconds} 秒` })
        )
      );
    });
    return aiUi.h(
      'nav',
      { class: 'wb-panel wb-groups', attrs: { 'aria-label': '镜头组' } },
      aiUi.h(
        'div',
        { class: 'wb-panel__header' },
        aiUi.h('div', {}, aiUi.h('h2', { class: 'wb-panel__title', text: '镜头组' }), aiUi.h('p', { class: 'wb-panel__subtitle', text: '选择一组查看内容与进度' })),
        aiUi.h('span', { class: 'wb-count', text: `${view.groups.length} 组` })
      ),
      aiUi.h('ul', { class: 'wb-panel__body wb-groups__list' }, items),
      renderRegroup()
    );
  }

  /** 左栏底部：镜头总数，以及按填写的单组最长时长重新分组（有进行中的任务时禁用）。 */
  function renderRegroup() {
    const shotTotal = view.groups.reduce((sum, group) => sum + group.shots.length, 0);
    const max = modelMaxSeconds();
    if (regroupSeconds === '') regroupSeconds = String(max !== null && max <= 120 ? max : view.groupMaxSeconds);
    const secondsInput = aiUi.textInput({ value: regroupSeconds, ariaLabel: '重新分组时每组最长（秒）', onChange: (value) => (regroupSeconds = value) });
    return aiUi.h(
      'div',
      { class: 'wb-panel__footer' },
      aiUi.h('p', { class: 'description', text: `共 ${shotTotal} 个镜头` }),
      aiUi.h(
        'div',
        { class: 'wb-regroup' },
        aiUi.h('span', { class: 'description', text: '每组最长' }),
        aiUi.h('div', { class: 'wb-regroup__input' }, secondsInput.element),
        aiUi.h('span', { class: 'description', text: '秒' }),
        aiUi.button({ text: '重新分组', compact: true, disabled: view.groups.some(hasActiveJob), onClick: () => void regroup(secondsInput.getValue()) }).element
      )
    );
  }

  /** 中栏：选中镜头组的详情。头部是固定标题与“编辑镜头”；内容依次是组标题与摘要（含出场实体概览）、镜头列表、生成状态。 */
  function renderDetailPanel(group, index) {
    const status = groupStatus(group);
    const groupValues = groupResolved(group) || resolved;
    const aspectRatio = groupValues ? groupValues.values.aspectRatio : '';
    const summary = [`${group.shots.length} 个镜头`, `总时长 ${group.totalSeconds} 秒`, aspectRatio, describeEntities(group)].filter(Boolean).join(' · ');
    const max = groupModelMaxSeconds(group);
    const body = aiUi.h(
      'div',
      { class: 'wb-panel__body wb-detail__body' },
      aiUi.h(
        'div',
        { class: 'wb-detail-head' },
        aiUi.h('div', {}, aiUi.h('h3', { class: 'wb-detail-title', text: `第 ${group.seq} 组` }), aiUi.h('p', { class: 'wb-detail-summary', text: summary })),
        aiUi.h('span', { class: `wb-detail-status ${status.className}`, text: status.text })
      ),
      exceedsModel(group) ? aiUi.h('p', { class: 'status-warning', text: `超过所选模型单次最长 ${max} 秒，请拆分这一组或换一个模型。` }) : null,
      renderShotList(group, index),
      renderStatusSection(group)
    );
    keepShotListHeight(body);
    return aiUi.h(
      'section',
      { class: 'wb-panel wb-detail', attrs: { 'aria-label': `第 ${group.seq} 组详情` } },
      aiUi.h(
        'div',
        { class: 'wb-panel__header' },
        aiUi.h('div', {}, aiUi.h('h2', { class: 'wb-panel__title', text: '镜头组详情' }), aiUi.h('p', { class: 'wb-panel__subtitle', text: '分镜内容与出场实体集中查看' })),
        aiUi.button({ text: '编辑镜头', ariaLabel: `编辑第 ${group.seq} 组的镜头`, onClick: () => editGroupShots(group) }).element
      ),
      body
    );
  }

  /**
   * 展开“提交的提示词”“历史记录”等折叠内容时，让镜头列表保持当前高度，多出来的内容靠整个详情区滚动；全部收起后列表恢复自然撑高。
   * 点击摘要时（内容展开之前）记下列表高度并锁定，所有折叠内容收起后解除。
   */
  function keepShotListHeight(body) {
    const list = body.querySelector('.wb-shot-list');
    if (!list) return;
    body.addEventListener(
      'click',
      (event) => {
        if (!event.target.closest('summary') || list.style.flex !== '') return;
        list.style.flex = `0 0 ${list.getBoundingClientRect().height}px`;
      },
      true
    );
    body.addEventListener(
      'toggle',
      () => {
        if (body.querySelector('details[open]')) return;
        list.style.flex = '';
      },
      true
    );
  }

  /** 出场实体概览一句话：各类型的数量与未绑定的数量，放在组摘要里；具体的实体和绑定在右栏“绑定素材”步骤里。 */
  function describeEntities(group) {
    if (group.entities.length === 0) return '无出场实体';
    const unbound = group.entities.filter((entity) => !entity.bound).length;
    const counts = new Map();
    for (const entity of group.entities) counts.set(entity.kindLabel, (counts.get(entity.kindLabel) || 0) + 1);
    const typeText = [...counts].map(([label, count]) => `${label} ${count}`).join(' · ');
    return `${typeText}，${unbound > 0 ? `其中 ${unbound} 项未绑定` : '已全部绑定'}`;
  }

  /** 详情里的一个区块：标题行（右侧可放操作）加内容。 */
  function renderSection(label, title, actions, ...content) {
    return aiUi.h(
      'section',
      { class: 'wb-section', attrs: { 'aria-label': label } },
      aiUi.h('div', { class: 'wb-section__head' }, aiUi.h('h3', { class: 'wb-section__title', text: title }), aiUi.h('div', { class: 'wb-section__actions' }, actions)),
      content
    );
  }

  /** 镜头列表：每个镜头一行（序号、景别与画面动作加场次、时长）；没有生成记录的组可在某个镜头前拆开，也可并入上一组。 */
  function renderShotList(group, index) {
    const canEdit = group.jobs.length === 0 && !submitting.has(group.id);
    const previous = view.groups[index - 1];
    const canMerge = canEdit && Boolean(previous) && previous.jobs.length === 0;
    const rows = group.shots.map((shot, shotIndex) =>
      aiUi.h(
        'li',
        { class: 'wb-shot' },
        aiUi.h('span', { class: 'wb-shot__seq', text: `镜头 ${shot.seq}` }),
        aiUi.h(
          'div',
          { class: 'wb-shot__body' },
          aiUi.h('p', { class: 'wb-shot__action', text: [shot.shotSize, shot.action].filter(Boolean).join(' · ') }),
          shot.sceneLabel ? aiUi.h('span', { class: 'wb-shot__scene', text: shot.sceneLabel }) : null
        ),
        aiUi.h(
          'div',
          { class: 'wb-shot__side' },
          aiUi.h('span', { class: 'wb-shot__duration', text: `${shot.durationSeconds} 秒` }),
          shotIndex > 0 && canEdit
            ? aiUi.button({ text: '从这里拆开', compact: true, ariaLabel: `在镜头 ${shot.seq} 之前拆开这一组`, onClick: () => void splitBefore(shot) }).element
            : null
        )
      )
    );
    const merge = canMerge ? aiUi.button({ text: '并入上一组', ariaLabel: `把第 ${group.seq} 组并入上一组`, onClick: () => void mergeIntoPrevious(group) }) : null;
    if (merge) merge.element.classList.add('wb-shots__more');
    return aiUi.h('div', { class: 'wb-shot-list' }, aiUi.h('ol', { class: 'wb-shots', attrs: { 'aria-label': '镜头' } }, rows), merge && merge.element);
  }

  /** 生成状态区块：任务进行中时有“取消”；有多个结果时有“结果版本”；下面是最新任务与历史。提交统一在右栏“检查并提交”步骤里做。 */
  function renderStatusSection(group) {
    const active = group.jobs.find((job) => ACTIVE_STATUSES.includes(job.status));
    const buttons = [];
    if (active) {
      buttons.push(aiUi.button({ text: '取消', compact: true, variant: 'danger', ariaLabel: `取消第 ${group.seq} 组的任务`, onClick: () => void cancelJob(active) }));
    }
    if (resultCount(group) > 1) {
      buttons.push(aiUi.button({ text: `结果版本（${resultCount(group)}）`, compact: true, ariaLabel: `查看第 ${group.seq} 组的结果版本`, onClick: () => openVersions(group) }));
    }
    return renderSection('生成状态', '生成状态', buttons.map((button) => button.element), renderGroupStatus(group));
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

  /** 底部队列与结果：标题行是摘要和展开、收起按钮，展开后列出每个任务（最新的在前），在表格内部滚动。 */
  function renderQueue() {
    const panelId = 'wb-queue-panel';
    const toggle = aiUi.button({
      text: queueOpen ? '收起队列' : '展开队列',
      compact: true,
      onClick: () => {
        queueOpen = !queueOpen;
        render();
      }
    });
    toggle.element.setAttribute('aria-expanded', String(queueOpen));
    toggle.element.setAttribute('aria-controls', panelId);
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
            buttons.push(aiUi.button({ text: '查看结果', compact: true, ariaLabel: `播放第 ${group.seq} 组第 ${job.attempt} 次的视频`, onClick: () => playResult(job.result, `第 ${group.seq} 组 · 第 ${job.attempt} 次`) }));
          }
          return buttons.map((button) => button.element);
        }
      }
    ];
    return aiUi.h(
      'section',
      { class: `wb-queue${queueOpen ? ' wb-queue--open' : ''}`, attrs: { 'aria-label': '队列与结果' } },
      aiUi.h(
        'div',
        { class: 'wb-queue__header' },
        aiUi.h('div', { class: 'wb-queue__title' }, aiUi.h('h2', { class: 'wb-panel__title', text: '队列与结果' }), aiUi.h('span', { class: 'description', text: queueSummary() })),
        toggle.element
      ),
      aiUi.h(
        'div',
        { class: 'wb-queue__body', hidden: !queueOpen, attrs: { id: panelId } },
        rows.length === 0 ? aiUi.h('p', { class: 'description wb-queue__empty', text: '还没有提交过生成任务。' }) : aiUi.table({ columns, rows, ariaLabel: '生成任务' }).element
      )
    );
  }

  /** 空状态和错误状态。 */
  function renderState(text, button) {
    return aiUi.h('div', { class: 'wb-state' }, aiUi.h('p', { class: 'description', text }), button && button.element);
  }

  /** 内容区上方的提示：没有可用模型、生成参数需要调整、分镜脚本未确认。 */
  function renderNotices() {
    const notices = [];
    if (catalog.models.length === 0) {
      notices.push(aiUi.h('p', { class: 'status-warning wb-notice', text: '没有可用的视频模型。请在“模型设置”中启用服务商、填写访问密钥并启用视频模型。' }));
    }
    if (resolved && Object.keys(resolved.issues).length > 0) {
      notices.push(aiUi.h('p', { class: 'status-warning wb-notice', text: `生成参数需要调整：${Object.values(resolved.issues).join('')}请在右侧“配置参数”步骤中修改。` }));
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

  /** 记下各滚动区域的位置；重绘会重建这些元素，位置会丢失。 */
  function captureScroll() {
    return SCROLL_SELECTORS.map((selector) => [...contentElement.querySelectorAll(selector)].map((element) => element.scrollTop));
  }

  /** 恢复滚动位置；切换到另一个镜头组时详情回到顶部。 */
  function restoreScroll(saved, resetDetail) {
    SCROLL_SELECTORS.forEach((selector, selectorIndex) => {
      if (resetDetail && (selector === '.wb-detail__body' || selector === '.wb-shots')) return;
      contentElement.querySelectorAll(selector).forEach((element, index) => {
        element.scrollTop = saved[selectorIndex][index] || 0;
      });
    });
  }

  /** 按当前状态刷新内容区。 */
  function render() {
    const scroll = captureScroll();
    const previousGroupId = selectedGroupId;
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
    if (view.groups.length === 0) {
      contentElement.append(renderState('这一集没有镜头。'));
      return;
    }
    const index = selectedGroupIndex();
    const group = view.groups[index];
    selectedGroupId = group.id;
    contentElement.append(aiUi.h('div', { class: 'wb-workspace' }, renderGroupsPanel(group.id), renderDetailPanel(group, index), stepTabs.element), renderQueue());
    restoreScroll(scroll, previousGroupId !== group.id);
    updateStepTabs();
    profilePanel.refresh();
    submitPanel.refresh();
  }

  /** 加载当前集的视图。 */
  async function loadEpisode(showLoading) {
    if (!catalog || episodeKey === '') {
      view = null;
      profile = null;
      updateResolved();
      isLoading = false;
      renderContext();
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
    renderContext();
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
      renderContext();
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

  /** 渲染页面骨架：顶部上下文栏、操作结果、内容区；创建右栏三个步骤的面板。 */
  function renderPage() {
    contextElement = aiUi.h('section', { class: 'wb-context', hidden: true, attrs: { 'aria-label': '当前集与生成配置' } });
    messageElement = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    contentElement = aiUi.h('div', { class: 'wb-content' });
    root.append(contextElement, messageElement, contentElement);
    // 三个步骤的面板创建一次，之后只在步骤之间切换显示。
    bindingsPanel = aiBindings.create();
    profilePanel = aiProfile.create({ getState: () => ({ catalog, profile, group: profileGroup() }), save: saveProfile });
    submitPanel = aiSubmit.create({
      getState: () => ({ view, resolved, episodeKey, busyGroupIds: submitting }),
      isVisible: () => Boolean(stepTabs) && stepTabs.getActive() === 'submit' && stepTabs.element.isConnected,
      groupStatus,
      isSelectable: (group) => !hasActiveJob(group) && !submitting.has(group.id),
      isPending: isPendingGroup,
      openPrevious: () => stepTabs.showPrevious(),
      preview: (groupIds) => window.hostBridge.request(REQUEST_PREVIEW, submitPayload(groupIds)),
      submit: submitSelected
    });
    stepTabs = aiStepTabs.create({
      ariaLabel: '生成步骤',
      initial: 'bindings',
      tabs: [
        { id: 'bindings', label: '绑定素材', build: () => bindingsPanel },
        { id: 'profile', label: '配置参数', build: () => profilePanel },
        { id: 'submit', label: '检查并提交', build: () => submitPanel }
      ]
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
