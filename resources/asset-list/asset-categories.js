// ------------------------------------------------------------------------
// 名称：asset-categories.js
// 说明：资产分类管理弹出页：列出当前资产类型的全部分类（含资产数量），在其上再弹出创建、编辑分类的表单，带影响提示地删除分类。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-03
// 备注：请求与表单名称与 src/app/pages/asset-category-handlers.ts、src/app/forms/asset-category-form.ts 一致；依赖 form/form-runtime.js（aiForm）；分类数据由资产列表页加载后传入，创建、编辑、删除后宿主推送变化事件，列表页重新加载并调用 refresh 更新本页；对外是 window.aiAssetCategories 的 open、refresh。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_PREPARE_DELETE = 'assetCategories.prepareDelete';
  const REQUEST_DELETE = 'assetCategories.delete';
  const FORM_CREATE = 'assetCategory.create';
  const FORM_EDIT = 'assetCategory.edit';

  const GENERIC_ERROR_TEXT = '操作失败，请重试。';
  const PAGE_WIDTH = 520;
  const PAGE_HEIGHT = 420;
  const PAGE_MIN_WIDTH = 360;
  const PAGE_MIN_HEIGHT = 240;

  /** 当前打开的分类管理页；没有打开时为 null。 */
  let session = null;

  /** 在提示区显示文字；空串表示清除。 */
  function showMessage(text, isError) {
    session.message.textContent = text;
    session.message.className = isError ? 'asset-cat__message status-error' : 'asset-cat__message status-success';
    session.message.hidden = text === '';
  }

  /** 发起请求；失败时在提示区显示原因并返回 undefined。 */
  async function runAction(name, payload) {
    showMessage('', false);
    try {
      return await window.hostBridge.request(name, payload);
    } catch (error) {
      if (session) showMessage((error && error.message) || GENERIC_ERROR_TEXT, true);
      return undefined;
    }
  }

  /** 弹出表单；已有表单打开时忽略，避免重复点击叠出多个；保存成功后在提示区显示 savedText。 */
  async function showForm(options, savedText) {
    if (session.isFormOpen) return;
    session.isFormOpen = true;
    showMessage('', false);
    try {
      const isSaved = await aiForm.open(options);
      if (isSaved && session) showMessage(savedText, false);
    } finally {
      if (session) session.isFormOpen = false;
    }
  }

  /** 删除分类：先取受影响的资产数量，再用页内对话框确认，最后请求删除。 */
  async function deleteCategory(category) {
    const impact = await runAction(REQUEST_PREPARE_DELETE, { id: category.id });
    if (!impact || !session) return;

    const details = impact.assetCount > 0 ? [`该分类下的 ${impact.assetCount} 个${session.label}资产不会被删除，会变为未分类。`] : [];
    const confirmed = await aiUi.confirm({
      title: `删除${session.label}分类`,
      message: `将删除分类“${impact.name}”。`,
      details,
      confirmText: '删除',
      variant: 'danger'
    });
    if (!confirmed || !session) return;

    const result = await runAction(REQUEST_DELETE, { id: category.id });
    if (result && session) showMessage(`已删除分类“${result.name}”。`, false);
  }

  /** 分类表格的列：名称、资产数量（为 0 时淡化）、修改与删除按钮。 */
  function buildColumns() {
    return [
      { title: '分类名称', width: '55%', minWidth: 140, render: (category) => aiUi.tableMainCell({ text: category.name }) },
      { title: '资产数', key: 'assetCount', type: 'number', muted: (category) => category.assetCount === 0 },
      {
        title: '操作',
        type: 'actions',
        render: (category) => [
          aiUi.button({ kind: 'edit', compact: true, ariaLabel: `修改分类：${category.name}`, onClick: () => void showForm({ form: FORM_EDIT, params: { categoryId: category.id } }, '已保存分类。') }).element,
          aiUi.button({ kind: 'delete', compact: true, ariaLabel: `删除分类：${category.name}`, onClick: () => void deleteCategory(category) }).element
        ]
      }
    ];
  }

  /** 按当前分类刷新内容区：没有分类时显示空状态，否则显示表格。 */
  function renderBody() {
    session.body.textContent = '';
    if (session.categories.length === 0) {
      session.body.append(aiUi.h('p', { class: 'description', text: `还没有${session.label}分类，点“创建分类”添加。` }));
      return;
    }
    session.body.append(aiUi.table({ columns: buildColumns(), rows: session.categories, ariaLabel: `${session.label}分类` }).element);
  }

  /**
   * 打开分类管理页。
   * @param {{ kind: string, label: string, categories: Array<{ id: number, name: string, assetCount: number }> }} options
   *   kind 为资产类型，label 为类型的界面名称（如“角色”），categories 为当前类型的分类。
   */
  function open(options) {
    if (session) return;
    const create = aiUi.button({
      kind: 'add',
      text: '创建分类',
      onClick: () => void showForm({ form: FORM_CREATE, params: { kind: options.kind } }, '已创建分类。')
    });
    const message = aiUi.h('p', { class: 'asset-cat__message', hidden: true, attrs: { role: 'status' } });
    const body = aiUi.h('div');
    session = { label: options.label, categories: options.categories, message, body, isFormOpen: false };
    const page = aiUi.openPage({
      title: `${options.label}分类管理`,
      content: aiUi.h('div', { class: 'asset-cat' }, aiUi.h('div', { class: 'asset-cat__bar' }, create.element), message, body),
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      minWidth: PAGE_MIN_WIDTH,
      minHeight: PAGE_MIN_HEIGHT,
      buttons: [{ id: 'close', text: '关闭', isCancel: true }]
    });
    page.closed.then(() => {
      session = null;
    });
    renderBody();
  }

  /** 数据变化后用最新的分类更新已打开的管理页；没有打开时忽略。 */
  function refresh(categories) {
    if (!session) return;
    session.categories = categories;
    renderBody();
  }

  window.aiAssetCategories = { open, refresh };
})();
