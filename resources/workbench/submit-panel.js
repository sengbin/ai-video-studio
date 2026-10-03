// ------------------------------------------------------------------------
// 名称：submit-panel.js
// 说明：提交面板（检查器的“提交”页签，对应表单 F10）：勾选要提交的镜头组，调用宿主的“预览提交”得到逐组汇总（整组时长、首帧来源、参考素材数量、声音与声音内容、种子）与阻断问题、提醒，没有阻断问题（提醒需勾选“已了解”）时才能提交所选镜头组。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：必须先于 workbench.js 加载；对外是 window.aiSubmit.create(host)，返回面板元素与 refresh、select；预览只在面板可见时请求，并按选择、参数和镜头组任务状态去重；宿主提供的 host 见 create 的说明。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const PREVIEW_DELAY_MS = 150;
  const AUDIO_MODE_LABELS = { native: '模型生成声音', none: '无声' };
  const FIRST_FRAME_LABELS = { none: '无', previous_tail: '上一组尾帧', image: '指定图片' };
  const GENERIC_ERROR_TEXT = '操作失败，请重试。';

  /** 取错误载荷中的说明文字：有字段错误时列出各项，否则用错误说明。 */
  function errorText(error) {
    const fields = error && error.fieldErrors ? Object.values(error.fieldErrors) : [];
    if (fields.length > 0) return fields.join('\n');
    return (error && error.message) || GENERIC_ERROR_TEXT;
  }

  /** 一个镜头组一行摘要：整组时长、首帧、参考素材与声音。 */
  function describePreview(preview) {
    const parts = [
      preview.durationSeconds === null ? `${preview.totalSeconds} 秒` : `整组 ${preview.durationSeconds} 秒`,
      `${preview.shotCount} 个镜头`,
      `首帧：${FIRST_FRAME_LABELS[preview.firstFrame] || preview.firstFrame}`,
      `参考图 ${preview.referenceImageCount} 张`
    ];
    if (preview.referenceAudioCount > 0) parts.push(`参考音频 ${preview.referenceAudioCount} 段`);
    parts.push(`声音：${AUDIO_MODE_LABELS[preview.audioMode] || '默认'}`);
    if (preview.audioMode === 'native' && preview.audioElements !== null) parts.push(`声音内容：${aiProfile.describeElements(preview.audioElements) || '无'}`);
    parts.push(preview.seed === null ? '种子：随机' : `种子：${preview.seed}`);
    if (preview.promptExtend !== null) parts.push(`提示词改写：${preview.promptExtend ? '开' : '关'}`);
    return parts.join(' · ');
  }

  /**
   * 创建提交面板；只创建一个实例。
   * @param {{
   *   getState: () => { view: object|null, resolved: object|null, episodeKey: string, busyGroupIds: Set<number> },
   *   isVisible: () => boolean,
   *   groupStatus: (group: object) => { text: string, className: string },
   *   isSelectable: (group: object) => boolean,
   *   isPending: (group: object) => boolean,
   *   summarize: () => string,
   *   openTab: (id: string) => void,
   *   preview: (groupIds: number[]) => Promise<{ groups: object[] }>,
   *   submit: (groupIds: number[]) => Promise<void>
   * }} host 宿主页面提供的状态与操作：isSelectable 判断组能否勾选（没有进行中的任务），isPending 判断组是否“还没有结果也没有进行中任务”。
   * @returns {{ element: HTMLElement, refresh: () => void, select: (groupIds: number[]) => void }}
   */
  function create(host) {
    /** 勾选的镜头组；null 表示这一集还没有初始化（首次显示时勾选全部未完成的组）。 */
    let selection = null;
    let acknowledged = false;
    let episodeKey = '';
    let previews = new Map();
    let previewKey = '';
    let previewError = '';
    let isBusy = false;
    let timer = 0;
    let requestId = 0;
    /** 上次渲染时的输入摘要；后台刷新时输入没变就不重绘，避免打断键盘焦点。 */
    let renderedKey = '';

    const element = aiUi.h('div', { class: 'wb-submit' });

    /** 当前可勾选的镜头组标识；清理已不存在或已开始生成的组。 */
    function normalizeSelection(view) {
      const selectable = new Set(view.groups.filter((group) => host.isSelectable(group)).map((group) => group.id));
      if (selection === null) selection = new Set(view.groups.filter((group) => host.isPending(group) && selectable.has(group.id)).map((group) => group.id));
      for (const id of [...selection]) if (!selectable.has(id)) selection.delete(id);
    }

    function selectedIds(view) {
      return view.groups.filter((group) => selection.has(group.id)).map((group) => group.id);
    }

    /** 选择或参数、任务状态变化后，稍作等待再请求预览；内容没有变化时不重复请求。 */
    function schedulePreview(view, ids) {
      const { resolved } = host.getState();
      const key = JSON.stringify([episodeKey, ids, resolved && resolved.values, view.groups.map((group) => [group.id,       group.totalSeconds, group.overrides, group.jobs.map((job) => [job.id, job.status])])]);
      if (key === previewKey) return;
      previewKey = key;
      window.clearTimeout(timer);
      if (ids.length === 0) {
        previews = new Map();
        previewError = '';
        return;
      }
      const current = ++requestId;
      timer = window.setTimeout(async () => {
        let data = null;
        let message = '';
        try {
          data = await host.preview(ids);
        } catch (error) {
          message = errorText(error);
        }
        if (current !== requestId) return;
        previews = new Map(data ? data.groups.map((preview) => [preview.groupId, preview]) : []);
        previewError = message;
        render();
      }, PREVIEW_DELAY_MS);
    }

    async function submit(ids) {
      isBusy = true;
      render();
      try {
        await host.submit(ids);
      } finally {
        isBusy = false;
        selection = new Set();
        acknowledged = false;
        previewKey = '';
        if (host.isVisible()) render();
      }
    }

    /** 一个镜头组的行：复选框、状态，勾选后显示预览的汇总、阻断问题与提醒。 */
    function renderGroup(group) {
      const checked = selection.has(group.id);
      const selectable = host.isSelectable(group);
      const status = host.groupStatus(group);
      const checkbox = aiUi.checkbox({
        label: `第 ${group.seq} 组 · ${group.totalSeconds} 秒 · ${group.shots.length} 个镜头`,
        checked,
        disabled: !selectable || isBusy,
        onChange: (value) => {
          if (value) selection.add(group.id);
          else selection.delete(group.id);
          acknowledged = false;
          render();
        }
      });
      const lines = [];
      const preview = checked ? previews.get(group.id) : undefined;
      if (preview) {
        lines.push(aiUi.h('div', { class: 'description', text: describePreview(preview) }));
        for (const issue of preview.blocking) lines.push(aiUi.h('div', { class: 'status-error', text: `✕ 阻断：${issue}` }));
        for (const warning of preview.warnings) lines.push(aiUi.h('div', { class: 'status-warning', text: `! 提醒：${warning}` }));
        // 提交前就能看到最终发给模型的提示词，方便检查写法是否符合预期。
        if (preview.prompt) {
          lines.push(aiUi.h('details', { class: 'wb-history' }, aiUi.h('summary', { text: '将提交的提示词' }), aiUi.h('div', { class: 'wb-prompt', text: preview.prompt })));
        }
      } else if (checked && !previewError) {
        lines.push(aiUi.h('div', { class: 'description', text: '正在检查…' }));
      }
      if (!selectable) lines.push(aiUi.h('div', { class: 'description', text: '正在生成，完成或取消后才能再次提交。' }));
      return aiUi.h(
        'li',
        { class: 'wb-submit__group' },
        aiUi.h('div', { class: 'wb-submit__head' }, checkbox.element, aiUi.h('span', { class: `wb-submit__status ${status.className}`, text: status.text })),
        lines.length > 0 ? aiUi.h('div', { class: 'wb-submit__details' }, lines) : null
      );
    }

    /** 影响显示的宿主状态摘要：集、各镜头组与任务状态、实体绑定、生效参数。 */
    function stateKey() {
      const { view, resolved, episodeKey: key, busyGroupIds } = host.getState();
      const groups = view ? view.groups.map((group) => [group.id, group.seq, group.totalSeconds, group.shots.length, group.overrides, group.jobs.map((job) => [job.id, job.status]), group.entities.map((entity) => entity.bound)]) : [];
      return JSON.stringify([key, view && view.canGenerate, view && view.blockReason, groups, resolved && [resolved.values, resolved.issues], [...busyGroupIds]]);
    }

    function render() {
      const { view, resolved } = host.getState();
      renderedKey = stateKey();
      element.textContent = '';
      if (!view || view.groups.length === 0) {
        element.append(aiUi.h('p', { class: 'description', text: '请先选择一个有镜头的集。' }));
        return;
      }
      normalizeSelection(view);
      const ids = selectedIds(view);
      if (!view.canGenerate) {
        element.append(aiUi.h('p', { class: 'status-warning', text: view.blockReason || '分镜脚本尚未确认采用。' }));
      }
      if (!resolved || !resolved.model || Object.keys(resolved.issues).length > 0) {
        element.append(
          aiUi.h(
            'div',
            { class: 'wb-submit__notice' },
            aiUi.h('span', { class: 'status-warning', text: resolved && resolved.model ? '生成参数需要调整后才能提交。' : '还没有可用的视频模型或生成参数。' }),
            aiUi.button({ text: '查看生成参数', compact: true, onClick: () => host.openTab('profile') }).element
          )
        );
      }
      element.append(aiUi.h('p', { class: 'description wb-submit__params', text: host.summarize() }));

      const quick = aiUi.h(
        'div',
        { class: 'wb-submit__quick' },
        aiUi.button({
          text: '全选',
          compact: true,
          disabled: isBusy,
          onClick: () => {
            selection = new Set(view.groups.filter((group) => host.isSelectable(group)).map((group) => group.id));
            acknowledged = false;
            render();
          }
        }).element,
        aiUi.button({
          text: '仅未完成',
          compact: true,
          disabled: isBusy,
          onClick: () => {
            selection = new Set(view.groups.filter((group) => host.isSelectable(group) && host.isPending(group)).map((group) => group.id));
            acknowledged = false;
            render();
          }
        }).element,
        aiUi.button({
          text: '清空',
          compact: true,
          disabled: isBusy || ids.length === 0,
          onClick: () => {
            selection = new Set();
            acknowledged = false;
            render();
          }
        }).element
      );
      element.append(quick, aiUi.h('ul', { class: 'wb-submit__list', attrs: { 'aria-label': '要提交的镜头组' } }, view.groups.map(renderGroup)));

      schedulePreview(view, ids);
      const chosen = ids.map((id) => previews.get(id)).filter(Boolean);
      const blockingCount = chosen.filter((preview) => preview.blocking.length > 0).length;
      const warningCount = chosen.filter((preview) => preview.warnings.length > 0).length;
      const needsAcknowledgement = warningCount > 0;
      if (previewError) element.append(aiUi.h('p', { class: 'status-error wb-message', text: `检查失败：${previewError}` }));

      const acknowledgement = needsAcknowledgement
        ? aiUi.checkbox({
            label: '我已了解以上提醒',
            checked: acknowledged,
            disabled: isBusy,
            onChange: (value) => {
              acknowledged = value;
              render();
            }
          })
        : null;
      const waiting = ids.length > 0 && chosen.length < ids.length && !previewError;
      const canSubmit =
        view.canGenerate && Boolean(resolved && resolved.model) && Object.keys(resolved.issues).length === 0 && ids.length > 0 && !waiting && !previewError && blockingCount === 0 && (!needsAcknowledgement || acknowledged) && !isBusy;
      const submitButton = aiUi.button({ text: isBusy ? '提交中…' : `提交所选（${ids.length}）`, variant: 'primary', disabled: !canSubmit, onClick: () => void submit(ids) });
      let hint = '';
      if (ids.length === 0) hint = '勾选要提交的镜头组。';
      else if (blockingCount > 0) hint = `${blockingCount} 个镜头组有阻断问题：取消勾选它们，或先处理问题后再提交。`;
      else if (needsAcknowledgement && !acknowledged) hint = '有提醒时需要勾选“我已了解以上提醒”。';
      element.append(
        aiUi.h(
          'div',
          { class: 'wb-submit__footer' },
          acknowledgement && acknowledgement.element,
          hint ? aiUi.h('p', { class: 'description', text: hint }) : null,
          submitButton.element
        )
      );
    }

    /** 数据变化后刷新；这一集变了就重置勾选，只有面板可见时才请求预览。 */
    function refresh() {
      const { episodeKey: nextKey } = host.getState();
      if (nextKey !== episodeKey) {
        episodeKey = nextKey;
        selection = null;
        acknowledged = false;
        previews = new Map();
        previewKey = '';
        previewError = '';
      }
      if (host.isVisible() && stateKey() !== renderedKey) render();
    }

    /** 外部指定勾选的镜头组（如“提交未完成的镜头组”）。 */
    function select(groupIds) {
      selection = new Set(groupIds);
      acknowledged = false;
      previewKey = '';
      if (host.isVisible()) render();
    }

    render();
    return { element, refresh, select };
  }

  window.aiSubmit = { create };
})();
