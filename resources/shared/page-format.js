// ------------------------------------------------------------------------
// 名称：page-format.js
// 说明：编辑器区页面共用的格式化与转换：相对时间、阶段状态文字与样式类、Base64 转字节。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：必须先于使用它的页面脚本加载；状态取值与 src/domain/models/stage-run.ts 的展示状态一致，另加 none（尚未开始）。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const JUST_NOW_TEXT = '刚刚';
  const RELATIVE_TIME_LIMIT_DAYS = 30;
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const DECODE_CHUNK = 0x8000;

  /** 阶段状态：界面文字与状态样式类（颜色之外必须带文字）。 */
  const STAGE_STATUSES = {
    none: { label: '未开始', className: 'description' },
    running: { label: '生成中', className: 'status-warning' },
    pending: { label: '待确认', className: 'status-warning' },
    approved: { label: '已确认', className: 'status-success' },
    history: { label: '历史版本', className: 'description' },
    failed: { label: '失败', className: 'status-error' },
    canceled: { label: '已取消', className: 'description' }
  };

  /**
   * 相对时间：一分钟内“刚刚”，30 天内用相对表述，更早显示日期。
   * @param {string} isoText ISO 8601 时间文本。
   */
  function formatRelativeTime(isoText) {
    const elapsed = Date.now() - Date.parse(isoText);
    if (Number.isNaN(elapsed) || elapsed < MINUTE_MS) return JUST_NOW_TEXT;
    const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
    if (elapsed < HOUR_MS) return formatter.format(-Math.floor(elapsed / MINUTE_MS), 'minute');
    if (elapsed < DAY_MS) return formatter.format(-Math.floor(elapsed / HOUR_MS), 'hour');
    if (elapsed < RELATIVE_TIME_LIMIT_DAYS * DAY_MS) return formatter.format(-Math.floor(elapsed / DAY_MS), 'day');
    return new Date(isoText).toLocaleDateString('zh-CN');
  }

  /** 阶段状态的界面文字；未知状态原样返回。 */
  function stageStatusLabel(display) {
    const status = STAGE_STATUSES[display];
    return status ? status.label : String(display);
  }

  /** 阶段状态的样式类；未知状态使用说明文字样式。 */
  function stageStatusClass(display) {
    const status = STAGE_STATUSES[display];
    return status ? status.className : 'description';
  }

  /** Base64 转字节；分块转换，避免大文件一次占用过多内存。 */
  function decodeBase64(text) {
    const binary = window.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let start = 0; start < binary.length; start += DECODE_CHUNK) {
      const end = Math.min(start + DECODE_CHUNK, binary.length);
      for (let index = start; index < end; index += 1) bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  window.pageFormat = { formatRelativeTime, stageStatusLabel, stageStatusClass, decodeBase64 };
})();
