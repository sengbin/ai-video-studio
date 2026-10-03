// ------------------------------------------------------------------------
// 名称：backup.js
// 说明：数据备份页脚本：显示数据库路径、大小、版本和各类数据数量；“备份到文件…”导出一致的快照；“从文件恢复…”选择并校验备份文件，页内对话框确认后准备恢复，重新加载窗口后生效；数据库无法打开时只显示原因与恢复。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：请求名称与 src/app/pages/backup-handlers.ts 一致；备份文件路径只在宿主内保存，确认恢复只带选择时返回的标识、取消恢复只带待恢复项的标识；操作进行中按钮都禁用，防止重复提交。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_LOAD = 'backup.load';
  const REQUEST_EXPORT = 'backup.export';
  const REQUEST_CHOOSE_RESTORE_FILE = 'backup.chooseRestoreFile';
  const REQUEST_RESTORE = 'backup.restore';
  const REQUEST_CANCEL_RESTORE = 'backup.cancelRestore';
  const REQUEST_RELOAD_WINDOW = 'backup.reloadWindow';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const BACKUP_BUSY_TEXT = '正在备份…';
  const CHOOSE_BUSY_TEXT = '正在检查备份文件…';
  const RESTORE_BUSY_TEXT = '正在准备恢复…';
  const CANCEL_RESTORE_BUSY_TEXT = '正在取消恢复…';
  const RELOAD_BUSY_TEXT = '正在重新加载窗口…';
  const CANCELLED_TEXT = '已取消，没有做任何改动。';
  const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'];
  const BYTE_STEP = 1024;
  /** 各类数据的显示名称，顺序即页面显示顺序；键与 src/domain/models/backup.ts 的 BackupDataCounts 一致。 */
  const COUNT_LABELS = [
    ['projects', '项目'],
    ['works', '作品'],
    ['episodes', '集'],
    ['assets', '资产'],
    ['shots', '镜头'],
    ['videoResults', '视频结果']
  ];

  const root = document.getElementById('app');
  document.body.classList.add('backup-page');

  /** 当前读取到的概览；尚未加载成功时为 null。 */
  let overview = null;
  /** 是否有操作正在进行。 */
  let busy = false;

  /** 取错误载荷中的说明文字。 */
  function errorText(error) {
    return (error && error.message) || GENERIC_ERROR_TEXT;
  }

  /** 文件大小的可读文字，如 “1.5 MB”。 */
  function formatBytes(bytes) {
    let value = bytes;
    let unit = 0;
    while (value >= BYTE_STEP && unit < BYTE_UNITS.length - 1) {
      value /= BYTE_STEP;
      unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
  }

  /** ISO 时间的本地时间文字。 */
  function formatTime(isoText) {
    return new Date(isoText).toLocaleString('zh-CN');
  }

  /**
   * 创建状态文字：颜色之外都带文字说明。
   * @returns {{ element: HTMLElement, show: (text: string, kind?: 'success'|'error'|'warning'|'info') => void }}
   */
  function createStatus() {
    const element = aiUi.h('p', { class: 'backup-status', hidden: true, attrs: { role: 'status' } });
    const classNames = { success: 'status-success', error: 'status-error', warning: 'status-warning', info: 'description' };
    return {
      element,
      show(text, kind) {
        element.textContent = text;
        element.className = `backup-status ${classNames[kind || 'info']}`;
        element.hidden = text === '';
      }
    };
  }

  /** 创建一个卡片：标题、说明段落和内容。 */
  function createCard(title, descriptions, ...content) {
    return aiUi.h(
      'section',
      { class: 'backup-card' },
      aiUi.h('h2', { class: 'backup-card__title', text: title }),
      ...descriptions.map((text) => aiUi.h('p', { class: 'backup-card__description', text })),
      ...content
    );
  }

  const backupStatus = createStatus();
  const restoreStatus = createStatus();
  const pendingStatus = createStatus();
  const pendingHost = aiUi.h('div');
  const factsHost = aiUi.h('div');

  const backupButton = aiUi.button({ text: '备份到文件…', variant: 'primary', onClick: () => void runBackup() });
  const restoreButton = aiUi.button({ text: '从文件恢复…', onClick: () => void runRestore() });
  /** 已准备恢复时的两个按钮，没有待恢复时为 null。 */
  let pendingButtons = null;

  /** 进行中时禁用全部操作按钮，结束后恢复。 */
  function setBusy(value) {
    busy = value;
    for (const button of [backupButton, restoreButton, ...(pendingButtons || [])]) button.setDisabled(value);
  }

  /** 重新读取概览并刷新显示；数据库无法打开时没有数据库信息可显示。 */
  async function refresh() {
    overview = await window.hostBridge.request(REQUEST_LOAD);
    renderFacts();
    renderPending();
  }

  /** 当前数据库信息：路径、大小、结构版本、各类数据数量、结果视频文件所在目录。 */
  function renderFacts() {
    const { database, latestSchemaVersion } = overview;
    if (database === null) return;
    const counts = COUNT_LABELS.map(([key, label]) => `${label} ${database.counts[key]}`).join('　');
    const rows = [
      ['数据库文件', database.databasePath],
      ['文件大小', formatBytes(database.sizeBytes)],
      ['结构版本', `${database.schemaVersion}（当前扩展支持到 ${latestSchemaVersion}）`],
      ['数据量', counts],
      ['结果视频', `${database.resultVideoDirectory}（不包含在备份中）`],
      ['资产文件', `${database.assetFileDirectory}（图片、音频，备份时复制到备份文件旁的 .files 文件夹）`]
    ];
    const list = aiUi.h('dl', { class: 'backup-facts' });
    for (const [label, value] of rows) {
      list.append(aiUi.h('dt', { text: label }), aiUi.h('dd', { text: value }));
    }
    factsHost.textContent = '';
    factsHost.append(list);
  }

  /** 已准备的恢复：提示重新加载窗口后生效，提供“重新加载窗口”与“取消恢复”。 */
  function renderPending() {
    pendingHost.textContent = '';
    pendingButtons = null;
    const pending = overview.pendingRestore;
    if (pending === null) return;
    const reloadButton = aiUi.button({ text: '重新加载窗口', variant: 'primary', disabled: busy, onClick: () => void reloadWindow() });
    const cancelButton = aiUi.button({ text: '取消恢复', disabled: busy, onClick: () => void cancelRestore() });
    pendingButtons = [reloadButton, cancelButton];
    pendingHost.append(
      createCard(
        '恢复已准备好，重新加载窗口后生效',
        [
          `已在 ${formatTime(pending.stagedAt)} 准备好待恢复的数据（${formatBytes(pending.sizeBytes)}）。重新加载窗口时，当前数据库会先自动备份到 ${overview.autoBackupDirectory}（文件名带时间戳），再被备份数据替换。`,
          '在重新加载窗口之前，当前数据没有任何改动，可以取消恢复。'
        ],
        aiUi.h('div', { class: 'backup-actions' }, reloadButton.element, cancelButton.element, pendingStatus.element)
      )
    );
  }

  /** 运行一项操作：进行中显示状态并禁用按钮，失败时在该状态文字处给出原因。 */
  async function runOperation(status, busyText, operation) {
    if (busy) return;
    setBusy(true);
    status.show(busyText, 'warning');
    try {
      await operation();
    } catch (error) {
      status.show(`失败：${errorText(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  /** 恢复确认里关于资产文件的说明：从备份文件旁的 .files 文件夹补回缺少的文件，找不到的文件会让对应的图片、音频无法显示。 */
  function describeAssetFiles(assetFiles) {
    if (assetFiles === null || assetFiles.referencedCount === 0) return '备份里没有资产图片、音频文件。';
    const missing = assetFiles.referencedCount - assetFiles.availableCount;
    if (missing === 0) return `备份引用的 ${assetFiles.referencedCount} 个资产文件齐全，缺少的会从 ${assetFiles.directory} 补回，不覆盖也不删除现有文件。`;
    return `备份引用 ${assetFiles.referencedCount} 个资产文件，其中 ${missing} 个在 ${assetFiles.directory} 和当前资产文件目录里都找不到，恢复后对应的图片、音频无法显示；请把备份文件的 .files 文件夹放在备份文件旁再选择。`;
  }

  /** 备份到文件。 */
  function runBackup() {
    return runOperation(backupStatus, BACKUP_BUSY_TEXT, async () => {
      const result = await window.hostBridge.request(REQUEST_EXPORT);
      if (result.cancelled) {
        backupStatus.show(CANCELLED_TEXT, 'info');
        return;
      }
      const files = result.assetFiles;
      const filesText = `资产文件 ${files.fileCount} 个（${formatBytes(files.sizeBytes)}）已复制到 ${files.directory}，恢复时请与备份文件放在一起。`;
      // 数据库引用但磁盘上找不到的文件没有复制，用警告样式单独提醒。
      if (files.missingCount > 0) {
        backupStatus.show(`已备份到 ${result.filePath}。注意：有 ${files.missingCount} 个资产文件在磁盘上找不到，没能备份，对应的图片或音频已经无法显示。${filesText}`, 'warning');
        return;
      }
      backupStatus.show(`已备份到 ${result.filePath}（${formatBytes(result.sizeBytes)}）。${filesText}`, 'success');
    });
  }

  /** 从文件恢复：选择并校验备份文件，确认后准备恢复。 */
  function runRestore() {
    return runOperation(restoreStatus, CHOOSE_BUSY_TEXT, async () => {
      const choice = await window.hostBridge.request(REQUEST_CHOOSE_RESTORE_FILE);
      if (choice.cancelled) {
        restoreStatus.show(CANCELLED_TEXT, 'info');
        return;
      }
      const candidate = choice.candidate;
      const upgradeText =
        candidate.schemaVersion < candidate.latestSchemaVersion
          ? `备份文件的结构版本为 ${candidate.schemaVersion}，低于当前的 ${candidate.latestSchemaVersion}，恢复后会自动升级。`
          : `备份文件的结构版本为 ${candidate.schemaVersion}，与当前扩展一致。`;
      const confirmed = await aiUi.confirm({
        title: '从备份恢复',
        variant: 'danger',
        confirmText: '覆盖并恢复',
        message: '恢复会用所选备份文件覆盖当前全部数据（项目、作品、资产、镜头、模型设置等），重新加载窗口后生效。',
        details: [
          `备份文件：${candidate.filePath}（${formatBytes(candidate.sizeBytes)}）`,
          upgradeText,
          `重新加载窗口时，当前数据库会先自动备份到 ${overview.autoBackupDirectory}。`,
          describeAssetFiles(candidate.assetFiles),
          '已下载到本地的结果视频文件不在备份内，不会被恢复，也不会被删除。'
        ]
      });
      if (!confirmed) {
        restoreStatus.show(CANCELLED_TEXT, 'info');
        return;
      }
      restoreStatus.show(RESTORE_BUSY_TEXT, 'warning');
      await window.hostBridge.request(REQUEST_RESTORE, { token: candidate.token });
      restoreStatus.show('恢复已准备好，请点上方的“重新加载窗口”使其生效。', 'success');
      await refresh();
    });
  }

  /** 放弃已准备的恢复。 */
  function cancelRestore() {
    return runOperation(pendingStatus, CANCEL_RESTORE_BUSY_TEXT, async () => {
      await window.hostBridge.request(REQUEST_CANCEL_RESTORE, { token: overview.pendingRestore.token });
      restoreStatus.show('已取消恢复，当前数据没有改动。', 'info');
      await refresh();
    });
  }

  /** 请求宿主重新加载窗口，使已准备的恢复生效；窗口重新加载后本页随之关闭。 */
  function reloadWindow() {
    return runOperation(pendingStatus, RELOAD_BUSY_TEXT, async () => {
      await window.hostBridge.request(REQUEST_RELOAD_WINDOW);
    });
  }

  /** 加载概览并渲染页面；失败时显示原因和“重试”。 */
  async function load() {
    root.textContent = '';
    root.append(aiUi.h('p', { class: 'description', text: '加载中…' }));
    try {
      await refresh();
    } catch (error) {
      root.textContent = '';
      root.append(
        aiUi.h('p', { class: 'status-error', text: `读取数据库信息失败：${errorText(error)}` }),
        aiUi.button({ text: '重试', onClick: () => void load() }).element
      );
      return;
    }
    root.textContent = '';
    // 数据库无法打开时只显示原因和“恢复”：备份与数据库信息都依赖可用的数据库。
    const unavailable = overview.database === null;
    const restoreCard = createCard(
      '恢复',
      [
        '选择之前备份的文件，用它覆盖当前全部数据。结构版本低于当前的备份会在重新加载后自动升级，高于当前扩展的备份会被拒绝。',
        '确认后需要重新加载窗口才会生效；重新加载时先把当前数据库自动备份（文件名带时间戳），再替换。'
      ],
      aiUi.h('div', { class: 'backup-actions' }, restoreButton.element, restoreStatus.element)
    );
    if (unavailable) {
      root.append(
        createCard(
          '数据库无法打开',
          [`数据库无法打开：${overview.databaseUnavailableReason}`, '在恢复之前，除本页外的其他功能暂时不可用。可以从之前备份的文件恢复数据；无法打开的数据库文件会先被自动备份，再被替换。'],
          aiUi.h('p', { class: 'backup-status status-error', text: '备份功能需要可用的数据库，当前只能恢复。' })
        ),
        pendingHost,
        restoreCard
      );
      return;
    }
    root.append(
      pendingHost,
      createCard('当前数据库', [], factsHost),
      createCard(
        '备份',
        [
          '把当前数据库导出为一个文件。导出的是一致的快照，使用过程中也可以备份。',
          '备份只含数据库（项目、作品、资产、镜头、模型设置等），不含已下载到本地的结果视频文件；如需保留这些视频，请自行复制上面“结果视频”所在的目录。'
        ],
        aiUi.h('div', { class: 'backup-actions' }, backupButton.element, backupStatus.element)
      ),
      restoreCard
    );
  }

  void load();
})();
