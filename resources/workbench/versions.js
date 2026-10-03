// ------------------------------------------------------------------------
// 名称：versions.js
// 说明：镜头组结果版本弹出页：列出这一组全部已生成的版本（每次成功的任务一个），可采用其中一个、打开、导出、在文件夹中显示，并勾选两个版本对比提交时的参数、结果信息与提示词的差异。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：不发请求，数据和操作由 workbench.js 注入；必须先于 workbench.js 加载；对外是 window.aiVersions 的 open、refresh；视频本身用系统播放器打开对比观看，页面内不播放。
// ------------------------------------------------------------------------

'use strict';

(function () {
  /** 对比时最多勾选的版本数。 */
  const COMPARE_COUNT = 2;
  const COMPARE_HINT = '勾选两个版本后可对比提交时的参数、结果信息和提示词；视频请用“打开视频”在系统播放器中对比观看。';

  /** 当前打开的版本页；没有打开时为 null。 */
  let dialog = null;

  /** 镜头组里有结果视频的任务，最新的在前。 */
  function versionsOf(group) {
    return group ? group.jobs.filter((job) => job.result) : [];
  }

  /** 宿主页面当前的这个镜头组；已不存在（如重新分组）时为 undefined。 */
  function currentGroup() {
    const { view } = dialog.host.getState();
    return view ? view.groups.find((group) => group.id === dialog.groupId) : undefined;
  }

  /** 在提示区显示文字；空串表示清除。 */
  function showMessage(text, isError) {
    dialog.messageElement.textContent = text;
    dialog.messageElement.className = isError ? 'wb-message status-error' : 'wb-message status-success';
    dialog.messageElement.hidden = text === '';
  }

  /** 按勾选数量刷新“对比”按钮。 */
  function updateCompareButton() {
    const count = dialog.selected.size;
    dialog.compareButton.setText(`对比所选版本（${count}/${COMPARE_COUNT}）`);
    dialog.compareButton.setDisabled(count !== COMPARE_COUNT);
  }

  /** 两个值是否相同：数组与对象按内容比较。 */
  function sameValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /** 对比弹出页：每个条目一行，两个版本的取值并排，不同的行标出“不同”。 */
  function openCompare(older, newer) {
    const left = older.fields;
    const right = newer.fields;
    const rows = left.map((field, index) => ({
      label: field.label,
      long: field.long === true,
      left: field.value,
      right: right[index].value,
      changed: !sameValue(field.value, right[index].value)
    }));
    const changedCount = rows.filter((row) => row.changed).length;
    const valueCell = (key) => (row) => aiUi.h('div', { class: row.long ? 'wb-prompt' : 'wb-diff__value', text: row[key] });
    const table = aiUi.table({
      columns: [
        { title: '项目', minWidth: 80, key: 'label', nowrap: true },
        { title: older.title, minWidth: 180, render: valueCell('left') },
        { title: newer.title, minWidth: 180, render: valueCell('right') },
        { title: '差异', width: 56, nowrap: true, render: (row) => (row.changed ? aiUi.chip({ text: '不同' }) : aiUi.h('span', { class: 'description', text: '相同' })) }
      ],
      rows,
      ariaLabel: '版本对比'
    });
    const summary = aiUi.h('p', { class: 'description', text: changedCount === 0 ? '两个版本提交时的参数、提示词和结果信息完全相同，只是重新生成了一次。' : `共 ${changedCount} 项不同。` });
    aiUi.openPage({
      title: '版本对比',
      content: aiUi.h('div', { class: 'wb-versions' }, summary, table.element),
      width: 760,
      height: 560,
      minWidth: 420,
      minHeight: 280,
      buttons: [{ id: 'close', text: '关闭', isCancel: true }]
    });
  }

  /** 对比当前勾选的两个版本，较早的放左边。 */
  function compareSelected() {
    const versions = versionsOf(currentGroup()).filter((job) => dialog.selected.has(job.id));
    if (versions.length !== COMPARE_COUNT) return;
    const [newer, older] = versions;
    const toSide = (job) => ({ title: `第 ${job.attempt} 次${job.result.isSelected ? '（已采用）' : ''}`, fields: dialog.host.describeFields(job) });
    openCompare(toSide(older), toSide(newer));
  }

  /** 勾选或取消勾选一个版本；超过两个时去掉最早勾选的。 */
  function toggle(job, checked) {
    if (checked) {
      dialog.selected.add(job.id);
      while (dialog.selected.size > COMPARE_COUNT) dialog.selected.delete(dialog.selected.values().next().value);
      renderBody();
    } else {
      dialog.selected.delete(job.id);
      updateCompareButton();
    }
  }

  /** 采用一个版本，结果在提示区显示。 */
  async function adopt(job) {
    const outcome = await dialog.host.select(job.result, dialog.groupId);
    if (!dialog || outcome.cancelled) return;
    showMessage(outcome.ok ? `已采用第 ${job.attempt} 次的结果。` : outcome.message, !outcome.ok);
  }

  /** 版本列表的列：勾选、版本与时间、提交参数与结果、操作。 */
  function buildColumns() {
    const { host } = dialog;
    return [
      {
        title: '对比',
        width: 56,
        render: (job) => aiUi.checkbox({ label: '', ariaLabel: `勾选第 ${job.attempt} 次用于对比`, checked: dialog.selected.has(job.id), onChange: (value) => toggle(job, value) }).element
      },
      {
        title: '版本',
        minWidth: 130,
        render: (job) =>
          aiUi.h(
            'div',
            {},
            aiUi.h('div', { class: 'wb-versions__title' }, aiUi.h('strong', { text: `第 ${job.attempt} 次` }), job.result.isSelected ? aiUi.chip({ text: '已采用' }) : null),
            aiUi.h('div', { class: 'description', text: new Date(job.finishedAt || job.createdAt).toLocaleString('zh-CN') })
          )
      },
      {
        title: '提交时的参数与结果',
        minWidth: 240,
        render: (job) => aiUi.h('div', {}, aiUi.h('div', { class: 'description', text: host.describeParams(job) }), aiUi.h('div', { class: 'description', text: `结果：${host.describeResult(job.result)}` }))
      },
      {
        title: '操作',
        type: 'actions',
        render: (job) => [
          aiUi.button({ text: '采用此版本', compact: true, variant: 'primary', disabled: job.result.isSelected, ariaLabel: `采用第 ${job.attempt} 次的结果`, onClick: () => void adopt(job) }).element,
          aiUi.button({ text: '打开视频', compact: true, onClick: () => void host.openResult(job.result) }).element,
          aiUi.button({ text: '导出…', compact: true, ariaLabel: '导出视频到指定位置', onClick: () => void host.exportResult(job.result) }).element,
          aiUi.button({ text: '在文件夹中显示', compact: true, onClick: () => void host.revealResult(job.result) }).element
        ]
      }
    ];
  }

  /** 重新绘制版本列表；镜头组或版本已不存在时关闭页面。 */
  function renderBody() {
    const group = currentGroup();
    const versions = versionsOf(group);
    if (!group || versions.length === 0) {
      dialog.page.close('api');
      return;
    }
    dialog.selected = new Set([...dialog.selected].filter((id) => versions.some((job) => job.id === id)));
    dialog.bodyElement.textContent = '';
    if (group.staleNote) dialog.bodyElement.append(aiUi.h('p', { class: 'status-warning', text: group.staleNote }));
    dialog.bodyElement.append(aiUi.table({ columns: buildColumns(), rows: versions, ariaLabel: `第 ${group.seq} 组的结果版本` }).element);
    updateCompareButton();
  }

  /**
   * 打开镜头组的版本页；已打开时不重复打开。
   * @param {number} groupId 镜头组标识。
   * @param {{ getState: () => { view: object|null },
   *   select: (result: object, groupId: number) => Promise<{ ok: boolean, cancelled?: boolean, message?: string }>,
   *   describeParams: (job: object) => string, describeResult: (result: object) => string,
   *   describeFields: (job: object) => Array<{ label: string, value: string, long?: boolean }>,
   *   openResult: (result: object) => Promise<void>, exportResult: (result: object) => Promise<void>, revealResult: (result: object) => Promise<void> }} host 宿主页面提供的数据与操作。
   */
  function open(groupId, host) {
    if (dialog) return;
    const messageElement = aiUi.h('p', { class: 'wb-message', hidden: true, attrs: { role: 'status' } });
    const bodyElement = aiUi.h('div');
    const compareButton = aiUi.button({ text: '', compact: true, disabled: true, onClick: compareSelected });
    const hint = aiUi.h('p', { class: 'description', text: COMPARE_HINT });
    const content = aiUi.h('div', { class: 'wb-versions' }, aiUi.h('div', { class: 'wb-versions__bar' }, compareButton.element, hint), messageElement, bodyElement);
    dialog = { host, groupId, selected: new Set(), messageElement, bodyElement, compareButton, page: null, key: '' };
    const group = currentGroup();
    dialog.page = aiUi.openPage({
      title: `第 ${group ? group.seq : ''} 组的结果版本`,
      content,
      width: 880,
      height: 520,
      minWidth: 420,
      minHeight: 260,
      buttons: [{ id: 'close', text: '关闭', isCancel: true }]
    });
    void dialog.page.closed.then(() => {
      dialog = null;
    });
    renderBody();
  }

  /** 页面数据变化后刷新版本页；这一组的任务没有变化时不重绘，避免打断勾选。 */
  function refresh() {
    if (!dialog) return;
    const group = currentGroup();
    const key = JSON.stringify(group ? [group.seq, group.staleNote, versionsOf(group).map((job) => [job.id, job.result.isSelected])] : null);
    if (key === dialog.key) return;
    dialog.key = key;
    renderBody();
  }

  window.aiVersions = { open, refresh };
})();
