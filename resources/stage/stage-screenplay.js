// ------------------------------------------------------------------------
// 名称：stage-screenplay.js
// 说明：剧本阶段的产出内容：左侧列表（剧本包正文、集、实体）、右侧编辑区、重新抽取，以及生成结束后的汇总。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：向 stage.js 的外壳登记；请求名称与 src/app/pages/stage-handlers.ts、表单名称与 src/app/forms/screenplay-form.ts 一致；集与实体的 ref 由宿主给出，页面只原样回传。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_SAVE_TEXT = 'stage.saveScreenplayText';
  const REQUEST_SAVE_EPISODE = 'stage.saveEpisode';
  const REQUEST_SAVE_ENTITY = 'stage.saveEntity';
  const REQUEST_REEXTRACT = 'stage.reextract';
  const FORM_START = 'screenplay.start';
  const SAVE_TEXT = '保存';
  const SAVED_TEXT = '已保存';
  const SAVE_STATE_DIRTY = 'dirty';
  const SAVE_STATE_SAVED = 'saved';
  const TYPE_TEXT = 'text';
  const TYPE_EPISODE = 'episode';
  const TYPE_ENTITY = 'entity';

  /**
   * 创建剧本阶段的内容。
   * @param context 外壳提供的 { runAction, showMessage, reload, getView, confirmDiscard }。
   */
  function create(context) {
    /** 当前选中的条目：{ type, ref }；ref 仅集和实体有。 */
    let selection = { type: TYPE_TEXT, ref: null };
    /** 编辑器当前对应的“版本:条目”，用来判断切换后是否需要重建。 */
    let editorKey = '';
    let editorDirty = false;
    let editorControls = null;
    let bodyContainer = null;

    /** 在最新视图中找到选中的集或实体；找不到返回 undefined。 */
    function findItem(view, current) {
      if (current.type === TYPE_EPISODE) return view.episodes.find((episode) => episode.ref === current.ref);
      if (current.type === TYPE_ENTITY) return view.entities.find((entity) => entity.ref === current.ref);
      return view.screenplay || undefined;
    }

    /** 实体类型的界面名称。 */
    function kindLabel(view, kind) {
      const item = view.entityKinds.find((candidate) => candidate.kind === kind);
      return item ? item.label : kind;
    }

    /** 生成结束后的汇总：集数、实体数，以及编辑的影响范围。 */
    function renderSummary(view) {
      if (!view.screenplay) return null;
      const counts = `共 ${view.episodes.length} 集、${view.entities.length} 个实体。`;
      const note = view.merged
        ? '集和实体已合并到作品，编辑将直接修改作品的集和实体。'
        : '确认采用前，集和实体只是抽取结果，不影响作品已有的数据；确认采用时才会合并。';
      return aiUi.h('p', { class: 'description', text: `${counts}${note}` });
    }

    /** 选择条目；有未保存的修改时先确认。 */
    async function select(next) {
      if (next.type === selection.type && next.ref === selection.ref) return;
      if (!(await context.confirmDiscard())) return;
      editorDirty = false;
      selection = next;
      renderBody(context.getView(), bodyContainer);
    }

    /** 左侧列表中的一个按钮。 */
    function renderItem(next, title, meta) {
      const isSelected = next.type === selection.type && next.ref === selection.ref;
      return aiUi.h(
        'button',
        {
          class: isSelected ? 'stage-item is-selected' : 'stage-item',
          attrs: { type: 'button', 'aria-current': isSelected ? 'true' : undefined },
          on: { click: () => void select(next) }
        },
        aiUi.h('span', { class: 'stage-item__title', text: title }),
        meta ? aiUi.h('span', { class: 'stage-item__meta', text: meta }) : null
      );
    }

    /** 左侧列表：剧本包正文、集、实体。 */
    function renderList(view) {
      const hasStructure = view.episodes.length > 0 || view.entities.length > 0;
      return aiUi.h(
        'aside',
        { class: 'stage-list' },
        renderItem({ type: TYPE_TEXT, ref: null }, '剧本包正文', view.screenplay ? `${view.screenplay.fullText.length} 字` : ''),
        hasStructure ? null : aiUi.h('p', { class: 'description', text: '集和实体抽取完成后会显示在这里。' }),
        hasStructure ? aiUi.h('p', { class: 'stage-list__heading', text: `集（${view.episodes.length}）` }) : null,
        view.episodes.map((episode) =>
          renderItem(
            { type: TYPE_EPISODE, ref: episode.ref },
            `${episode.seq}. ${episode.title}`,
            episode.targetDurationSeconds ? `${episode.targetDurationSeconds} 秒` : ''
          )
        ),
        hasStructure ? aiUi.h('p', { class: 'stage-list__heading', text: `实体（${view.entities.length}）` }) : null,
        view.entities.map((entity) =>
          renderItem({ type: TYPE_ENTITY, ref: entity.ref }, `[${kindLabel(view, entity.kind)}] ${entity.name}`, entity.isActive ? '' : '已停用')
        )
      );
    }

    /** 不能编辑时的原因。 */
    function readonlyReason(view) {
      const { run, actions } = view;
      if (actions.canEdit) return '';
      if (run.display === 'running') return '生成中，暂不能编辑。';
      if (run.display === 'failed' || run.display === 'canceled') return '生成尚未成功，暂不能编辑。';
      return '历史版本只读；如需修改，请切换到最新版本。';
    }

    /** 带标签的字段。 */
    function field(label, control, description) {
      return aiUi.field({ label, description, control }).element;
    }

    /** 剧本包正文编辑：标题与梗概只读显示，正文可改。 */
    function buildTextEditor(view, canEdit, markDirty) {
      const fullText = aiUi.textArea({ value: view.screenplay.fullText, ariaLabel: '剧本包正文', disabled: !canEdit, onChange: markDirty });
      return {
        fields: [
          aiUi.h('p', { class: 'description', text: `标题：${view.screenplay.title}` }),
          aiUi.h('p', { class: 'description', text: `梗概：${view.screenplay.overview}` }),
          aiUi.h('div', { class: 'stage-editor__content' }, fullText.element)
        ],
        collect: () => ({ fullText: fullText.getValue() }),
        refresh: (latest) => fullText.setValue(latest.fullText),
        request: REQUEST_SAVE_TEXT,
        note: '正文保存后，已抽取的集和实体不会自动更新，需要时点“重新抽取”。'
      };
    }

    /** 集编辑：标题、梗概、目标时长、本集剧本正文。 */
    function buildEpisodeEditor(view, episode, canEdit, markDirty) {
      const title = aiUi.textInput({ value: episode.title, disabled: !canEdit, onChange: markDirty });
      const synopsis = aiUi.textArea({ value: episode.synopsis, rows: 3, disabled: !canEdit, onChange: markDirty });
      const duration = aiUi.textInput({
        value: episode.targetDurationSeconds === null ? '' : String(episode.targetDurationSeconds),
        disabled: !canEdit,
        onChange: markDirty
      });
      const text = aiUi.textArea({ value: episode.screenplayText, disabled: !canEdit, onChange: markDirty });
      return {
        fields: [
          field('集标题', title),
          field('本集梗概', synopsis),
          field('本集目标时长（秒）', duration, '可选，填写正整数'),
          aiUi.h('div', { class: 'stage-editor__content' }, field('本集剧本正文', text))
        ],
        collect: () => ({
          title: title.getValue(),
          synopsis: synopsis.getValue(),
          targetDurationSeconds: duration.getValue(),
          screenplayText: text.getValue()
        }),
        refresh: (latest) => {
          title.setValue(latest.title);
          synopsis.setValue(latest.synopsis);
          duration.setValue(latest.targetDurationSeconds === null ? '' : String(latest.targetDurationSeconds));
          text.setValue(latest.screenplayText);
        },
        request: REQUEST_SAVE_EPISODE,
        note: ''
      };
    }

    /** 实体编辑：名称、别名、摘要、按类型区分的设定、是否启用。 */
    function buildEntityEditor(view, entity, canEdit, markDirty) {
      const kind = view.entityKinds.find((candidate) => candidate.kind === entity.kind);
      const name = aiUi.textInput({ value: entity.name, disabled: !canEdit, onChange: markDirty });
      const aliases = aiUi.textInput({ value: entity.aliases.join('，'), disabled: !canEdit, onChange: markDirty });
      const description = aiUi.textArea({ value: entity.description, minRows: 1, maxRows: 3, disabled: !canEdit, onChange: markDirty });
      const active = aiUi.switchControl({ label: '启用', checked: entity.isActive, disabled: !canEdit, onChange: markDirty });
      const attributes = new Map(
        kind.attributes.map((attribute) => [
          attribute.key,
          aiUi.textArea({ value: entity.attributes[attribute.key] || '', minRows: 1, maxRows: 3, disabled: !canEdit, onChange: markDirty })
        ])
      );
      return {
        fields: [
          aiUi.h('p', { class: 'description', text: `类型：${kind.label}（不能修改）` }),
          field('名称', name, '同类型内不能重复；改名不影响已有绑定和镜头引用'),
          field('别名', aliases, '多个别名用逗号分隔'),
          field('设定摘要', description),
          ...kind.attributes.map((attribute) => field(attribute.label, attributes.get(attribute.key))),
          active.element
        ],
        collect: () => ({
          name: name.getValue(),
          aliases: aliases.getValue(),
          description: description.getValue(),
          attributes: Object.fromEntries([...attributes].map(([key, control]) => [key, control.getValue()])),
          isActive: active.getValue()
        }),
        refresh: (latest) => {
          name.setValue(latest.name);
          aliases.setValue(latest.aliases.join('，'));
          description.setValue(latest.description);
          active.setValue(latest.isActive);
          for (const [key, control] of attributes) control.setValue(latest.attributes[key] || '');
        },
        request: REQUEST_SAVE_ENTITY,
        note: ''
      };
    }

    /** 保存当前条目；已确认的版本被编辑时先提示会回到待确认。 */
    async function save() {
      const view = context.getView();
      if (view.actions.editNeedsConfirm) {
        const confirmed = await aiUi.confirm({
          title: '保存修改',
          message: '该版本已确认采用。保存后将回到待确认，需要重新确认。',
          confirmText: '保存',
          cancelText: '取消'
        });
        if (!confirmed) return;
      }
      const { built } = editorControls;
      const payload = { id: view.run.id, ...built.collect() };
      if (selection.type !== TYPE_TEXT) payload.ref = selection.ref;
      if (await context.runAction(built.request, payload)) {
        editorDirty = false;
        await context.reload();
        // 重新加载后编辑区可能被重建（如已确认的版本保存后回到待确认），按钮状态要在重建后再设置。
        if (editorControls) editorControls.setSaveState(SAVE_STATE_SAVED);
        context.showMessage(built.note ? `已保存。${built.note}` : '已保存。', false);
      }
    }

    /** 用当前正文重新抽取集和实体。 */
    async function reextract() {
      if (!(await context.confirmDiscard())) return;
      const confirmed = await aiUi.confirm({
        title: '重新抽取',
        message: '将用当前剧本包正文重新抽取集和实体，覆盖现有的抽取结果（包括你对集和实体所做的修改）。',
        confirmText: '重新抽取'
      });
      if (!confirmed) return;
      editorDirty = false;
      if (await context.runAction(REQUEST_REEXTRACT, { id: context.getView().run.id })) await context.reload();
    }

    /** 右侧编辑区：切换条目时重建；同一条目有未保存的修改时保留输入。 */
    function renderEditor(view) {
      const item = findItem(view, selection);
      const canEdit = view.actions.canEdit;
      const key = `${view.run.id}:${selection.type}:${selection.ref}:${view.merged}:${canEdit}:${view.actions.editNeedsConfirm}`;
      if (editorControls && editorKey === key) {
        if (!editorDirty) editorControls.built.refresh(item);
        return editorControls.element;
      }

      editorKey = key;
      editorDirty = false;
      const saveButton = aiUi.button({ text: SAVE_TEXT, variant: 'primary', disabled: true, onClick: () => void save() });
      /** 保存按钮只在有修改时可点，保存后显示“已保存”，再次修改后恢复。 */
      const setSaveState = (state) => {
        saveButton.setText(state === SAVE_STATE_SAVED ? SAVED_TEXT : SAVE_TEXT);
        saveButton.setDisabled(state !== SAVE_STATE_DIRTY);
      };
      const markDirty = () => {
        editorDirty = true;
        setSaveState(SAVE_STATE_DIRTY);
      };

      const built =
        selection.type === TYPE_EPISODE
          ? buildEpisodeEditor(view, item, canEdit, markDirty)
          : selection.type === TYPE_ENTITY
            ? buildEntityEditor(view, item, canEdit, markDirty)
            : buildTextEditor(view, canEdit, markDirty);
      const reason = readonlyReason(view);
      const actions = [
        canEdit ? saveButton.element : null,
        canEdit && selection.type === TYPE_TEXT && view.actions.canReextract
          ? aiUi.button({ text: '重新抽取', onClick: () => void reextract() }).element
          : null
      ].filter(Boolean);

      const element = aiUi.h(
        'section',
        { class: 'stage-editor stage-editor--fields' },
        built.fields,
        reason ? aiUi.h('p', { class: 'description', text: reason }) : null,
        actions.length > 0 ? aiUi.h('div', { class: 'stage-editor__actions' }, actions) : null
      );
      editorControls = { key, element, built, setSaveState };
      return element;
    }

    /** 主体：左侧列表与右侧编辑区；选中的条目不存在时回到剧本包正文。 */
    function renderBody(view, container) {
      bodyContainer = container;
      container.textContent = '';
      if (!view.screenplay) {
        editorControls = null;
        editorKey = '';
        container.append(renderList(view), aiUi.h('div', { class: 'stage-detail' }, aiUi.h('p', { class: 'description', text: '剧本包正文生成后会显示在这里。' })));
        return;
      }
      if (selection.type !== TYPE_TEXT && !findItem(view, selection)) {
        selection = { type: TYPE_TEXT, ref: null };
        editorDirty = false;
      }
      container.append(renderList(view), aiUi.h('div', { class: 'stage-detail' }, renderEditor(view)));
    }

    return {
      render: renderBody,
      renderSummary,
      isDirty: () => editorDirty,
      discard: () => {
        editorDirty = false;
      }
    };
  }

  window.aiStage.registerStage({
    stage: 'screenplay',
    label: '剧本',
    regenerateForm: FORM_START,
    keptNote: '已完成的步骤已保留',
    discardMessage: '当前内容有未保存的修改，放弃这些修改？',
    approveNote: (view) =>
      view.merged
        ? '确认后它将继续作为后续分镜脚本的依据。'
        : '确认后将把抽取的集和实体合并到作品：集按序号更新，实体按类型与名称合并并保留已有绑定，不再出现的实体会被停用；它也将作为后续分镜脚本的依据。',
    confirmRegenerate: (view) =>
      view.merged || view.versions.some((item) => item.isCurrent)
        ? aiUi.confirm({
            title: '重新生成剧本',
            message: '重新生成不会立即改动已有的集和实体，确认采用新版本时才合并；已有绑定与参数保留。',
            confirmText: '继续'
          })
        : Promise.resolve(true),
    create
  });
})();
