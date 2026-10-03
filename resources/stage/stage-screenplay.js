// ------------------------------------------------------------------------
// 名称：stage-screenplay.js
// 说明：剧本阶段的产出内容：左侧列表（剧本包正文、集、实体）、右侧编辑区、集与实体的新增和删除、集的上移下移、重新抽取，以及生成结束后的汇总。
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
  const REQUEST_ADD_EPISODE = 'stage.addEpisode';
  const REQUEST_DELETE_EPISODE = 'stage.deleteEpisode';
  const REQUEST_MOVE_EPISODE = 'stage.moveEpisode';
  const REQUEST_ADD_ENTITY = 'stage.addEntity';
  const REQUEST_DELETE_ENTITY = 'stage.deleteEntity';
  const REQUEST_REEXTRACT = 'stage.reextract';
  const FORM_START = 'screenplay.start';
  const SAVE_TEXT = '保存';
  const ADD_TEXT = '添加';
  const SAVED_TEXT = '已保存';
  const SAVE_STATE_DIRTY = 'dirty';
  const SAVE_STATE_SAVED = 'saved';
  // 正文按内容增高，最多长到这个行数再滚动（与阶段页的编辑区高度相当）。
  const BODY_MAX_ROWS = 20;
  const TYPE_TEXT = 'text';
  const TYPE_EPISODE = 'episode';
  const TYPE_ENTITY = 'entity';
  // 尚未保存的新条目用这个定位值。
  const NEW_REF = 'new';
  const ALIAS_SEPARATORS = /[,，、\n]/;

  /**
   * 创建剧本阶段的内容。
   * @param context 外壳提供的 { runAction, showMessage, reload, getView, confirmDiscard }。
   */
  function create(context) {
    /** 当前选中的条目：{ type, ref, kind?, draft? }；ref 仅集和实体有，为 NEW_REF 表示正在新增（实体带 kind）。 */
    let selection = { type: TYPE_TEXT, ref: null };
    /** 编辑器当前对应的“版本:条目”，用来判断切换后是否需要重建。 */
    let editorKey = '';
    let editorDirty = false;
    let editorControls = null;
    let bodyContainer = null;

    /** 在最新视图中找到选中的集或实体；新增中的条目返回空白内容；找不到返回 undefined。 */
    function findItem(view, current) {
      if (current.ref === NEW_REF) {
        if (current.type === TYPE_EPISODE) return { title: '', synopsis: '', screenplayText: '', targetDurationSeconds: null };
        const draft = current.draft || {};
        return { kind: current.kind, name: draft.name || '', aliases: draft.aliases || [], description: draft.description || '', attributes: {}, isActive: true };
      }
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

    /** 左侧列表的分组标题；可编辑时右侧带“添加”按钮。 */
    function renderHeading(text, onAdd) {
      return aiUi.h(
        'div',
        { class: 'stage-list__head' },
        aiUi.h('p', { class: 'stage-list__heading', text }),
        onAdd ? aiUi.button({ kind: 'add', text: ADD_TEXT, compact: true, onClick: onAdd }).element : null
      );
    }

    /** 左侧列表：剧本包正文、集、实体。 */
    function renderList(view) {
      const hasStructure = view.episodes.length > 0 || view.entities.length > 0;
      const canEdit = view.actions.canEdit;
      const isNew = (type) => selection.type === type && selection.ref === NEW_REF;
      // 单个短视频只有 1 集，不能增删集。
      const canAddEpisode = canEdit && view.work.kind !== 'single';
      return aiUi.h(
        'aside',
        { class: 'stage-list' },
        renderItem({ type: TYPE_TEXT, ref: null }, '剧本包正文', view.screenplay ? `${view.screenplay.fullText.length} 字` : ''),
        hasStructure ? null : aiUi.h('p', { class: 'description', text: '集和实体抽取完成后会显示在这里。' }),
        hasStructure
          ? renderHeading(`集（${view.episodes.length}）`, canAddEpisode ? () => void select({ type: TYPE_EPISODE, ref: NEW_REF }) : null)
          : null,
        view.episodes.map((episode) =>
          renderItem(
            { type: TYPE_EPISODE, ref: episode.ref },
            `${episode.seq}. ${episode.title}`,
            episode.targetDurationSeconds ? `${episode.targetDurationSeconds} 秒` : ''
          )
        ),
        isNew(TYPE_EPISODE) ? renderItem({ type: TYPE_EPISODE, ref: NEW_REF }, '新增集', '未保存') : null,
        hasStructure
          ? renderHeading(
              `实体（${view.entities.length}）`,
              canEdit ? () => void select({ type: TYPE_ENTITY, ref: NEW_REF, kind: view.entityKinds[0].kind }) : null
            )
          : null,
        view.entities.map((entity) =>
          renderItem({ type: TYPE_ENTITY, ref: entity.ref }, `[${kindLabel(view, entity.kind)}] ${entity.name}`, entity.isActive ? '' : '已停用')
        ),
        isNew(TYPE_ENTITY) ? renderItem({ type: TYPE_ENTITY, ref: NEW_REF }, '新增实体', '未保存') : null
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
      const fullText = aiUi.textArea({ value: view.screenplay.fullText, ariaLabel: '剧本包正文', maxRows: BODY_MAX_ROWS, disabled: !canEdit, onChange: markDirty });
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
      const synopsis = aiUi.textArea({ value: episode.synopsis, maxRows: 4, disabled: !canEdit, onChange: markDirty });
      const duration = aiUi.textInput({
        value: episode.targetDurationSeconds === null ? '' : String(episode.targetDurationSeconds),
        disabled: !canEdit,
        onChange: markDirty
      });
      const text = aiUi.textArea({ value: episode.screenplayText, maxRows: BODY_MAX_ROWS, disabled: !canEdit, onChange: markDirty });
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

    /** 实体编辑：名称、别名、摘要、按类型区分的设定、是否启用；新增时可选类型，切换类型由 onKindChange 重建编辑区。 */
    function buildEntityEditor(view, entity, canEdit, markDirty, onKindChange) {
      const kind = view.entityKinds.find((candidate) => candidate.kind === entity.kind);
      const kindControl = onKindChange
        ? aiUi.select({
            options: view.entityKinds.map((item) => ({ value: item.kind, label: item.label })),
            value: entity.kind,
            allowEmpty: false,
            ariaLabel: '实体类型',
            onChange: () => onKindChange(kindControl.getValue())
          })
        : null;
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
          kindControl ? field('类型', kindControl, '切换类型会重置下面的设定字段') : aiUi.h('p', { class: 'description', text: `类型：${kind.label}（不能修改）` }),
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

    /** 保存当前条目（新增中的条目则添加）；已确认的版本被编辑时先提示会回到待确认。 */
    async function save() {
      const view = context.getView();
      const isNew = selection.ref === NEW_REF;
      if (view.actions.editNeedsConfirm) {
        const confirmed = await aiUi.confirm({
          title: isNew ? '添加' : '保存修改',
          message: `该版本已确认采用。${isNew ? '添加' : '保存'}后将回到待确认，需要重新确认。`,
          confirmText: isNew ? '添加' : '保存',
          cancelText: '取消'
        });
        if (!confirmed) return;
      }
      const { built } = editorControls;
      const payload = { id: view.run.id, ...built.collect() };
      if (isNew) {
        if (selection.type === TYPE_ENTITY) payload.kind = selection.kind;
      } else if (selection.type !== TYPE_TEXT) {
        payload.ref = selection.ref;
      }
      const addRequest = selection.type === TYPE_EPISODE ? REQUEST_ADD_EPISODE : REQUEST_ADD_ENTITY;
      const result = await context.runAction(isNew ? addRequest : built.request, payload);
      if (result) {
        editorDirty = false;
        // 新增成功后选中刚加入的条目。
        if (isNew) selection = { type: selection.type, ref: result.ref };
        await context.reload();
        // 重新加载后编辑区可能被重建（如已确认的版本保存后回到待确认），按钮状态要在重建后再设置。
        if (editorControls) editorControls.setSaveState(SAVE_STATE_SAVED);
        context.showMessage(isNew ? '已添加。' : built.note ? `已保存。${built.note}` : '已保存。', false);
      }
    }

    /** 删除当前的集或实体；先确认，并说明影响范围。 */
    async function remove() {
      const view = context.getView();
      const item = findItem(view, selection);
      const isEpisode = selection.type === TYPE_EPISODE;
      const lines = isEpisode
        ? [`删除第 ${item.seq} 集“${item.title}”后，后面的集序号会前移。`]
        : [`删除实体“${item.name}”。`];
      if (isEpisode && view.merged && (view.downstreamEpisodes || []).includes(item.seq)) lines.push('这一集的分镜脚本也会一并删除。');
      if (!isEpisode && view.merged) lines.push('已被镜头、声音或资产绑定引用的实体不能删除，可改为停用。');
      if (view.actions.editNeedsConfirm) lines.push('该版本已确认采用，删除后将回到待确认。');
      const confirmed = await aiUi.confirm({
        title: isEpisode ? '删除集' : '删除实体',
        message: lines,
        confirmText: '删除',
        variant: 'danger'
      });
      if (!confirmed) return;
      if (await context.runAction(isEpisode ? REQUEST_DELETE_EPISODE : REQUEST_DELETE_ENTITY, { id: view.run.id, ref: selection.ref })) {
        editorDirty = false;
        selection = { type: TYPE_TEXT, ref: null };
        await context.reload();
        context.showMessage('已删除。', false);
      }
    }

    /** 把当前的集与前一集（up）或后一集（down）互换位置；有未保存的修改时先确认放弃，已确认的版本先提示会回到待确认。 */
    async function moveEpisode(direction) {
      const view = context.getView();
      if (!(await context.confirmDiscard())) return;
      if (view.actions.editNeedsConfirm) {
        const confirmed = await aiUi.confirm({
          title: '调整集的顺序',
          message: '该版本已确认采用。调整顺序后将回到待确认，需要重新确认。',
          confirmText: '调整',
          cancelText: '取消'
        });
        if (!confirmed) return;
      }
      const result = await context.runAction(REQUEST_MOVE_EPISODE, { id: view.run.id, ref: selection.ref, direction });
      if (result) {
        editorDirty = false;
        // 未合并时定位值是抽取结果中的位置，要跟着集走。
        selection = { type: TYPE_EPISODE, ref: result.ref };
        await context.reload();
        context.showMessage('已调整顺序。', false);
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
      const key = `${view.run.id}:${selection.type}:${selection.ref}:${selection.kind || ''}:${view.merged}:${canEdit}:${view.actions.editNeedsConfirm}`;
      if (editorControls && editorKey === key) {
        if (!editorDirty) editorControls.built.refresh(item);
        return editorControls.element;
      }

      editorKey = key;
      editorDirty = false;
      const isNew = selection.ref === NEW_REF;
      const saveButton = aiUi.button({ text: isNew ? ADD_TEXT : SAVE_TEXT, variant: 'primary', disabled: !isNew, onClick: () => void save() });
      /** 保存按钮只在有修改时可点，保存后显示“已保存”，再次修改后恢复；新增的条目始终可点“添加”。 */
      const setSaveState = (state) => {
        saveButton.setText(state === SAVE_STATE_SAVED ? SAVED_TEXT : isNew ? ADD_TEXT : SAVE_TEXT);
        saveButton.setDisabled(!isNew && state !== SAVE_STATE_DIRTY);
      };
      const markDirty = () => {
        editorDirty = true;
        setSaveState(SAVE_STATE_DIRTY);
      };
      /** 新增实体时切换类型：保留已填的名称、别名和摘要，重建编辑区。 */
      const changeKind = (nextKind) => {
        const values = editorControls.built.collect();
        const wasDirty = editorDirty;
        const aliases = values.aliases.split(ALIAS_SEPARATORS).map((alias) => alias.trim()).filter(Boolean);
        selection = { type: TYPE_ENTITY, ref: NEW_REF, kind: nextKind, draft: { name: values.name, aliases, description: values.description } };
        renderBody(context.getView(), bodyContainer);
        editorDirty = wasDirty;
      };

      const built =
        selection.type === TYPE_EPISODE
          ? buildEpisodeEditor(view, item, canEdit, markDirty)
          : selection.type === TYPE_ENTITY
            ? buildEntityEditor(view, item, canEdit, markDirty, isNew ? changeKind : null)
            : buildTextEditor(view, canEdit, markDirty);
      const reason = readonlyReason(view);
      // 单个短视频只有 1 集，不能删除。
      const canRemove = canEdit && !isNew && selection.type !== TYPE_TEXT && !(selection.type === TYPE_EPISODE && view.work.kind === 'single');
      // 只有多集的已有集可以调整顺序。
      const canMove = canEdit && !isNew && selection.type === TYPE_EPISODE && view.work.kind !== 'single';
      const episodeIndex = view.episodes.findIndex((episode) => episode.ref === selection.ref);
      const actions = [
        canEdit ? saveButton.element : null,
        canMove ? aiUi.button({ text: '上移', disabled: episodeIndex === 0, onClick: () => void moveEpisode('up') }).element : null,
        canMove ? aiUi.button({ text: '下移', disabled: episodeIndex === view.episodes.length - 1, onClick: () => void moveEpisode('down') }).element : null,
        canEdit && selection.type === TYPE_TEXT && view.actions.canReextract
          ? aiUi.button({ text: '重新抽取', onClick: () => void reextract() }).element
          : null,
        canRemove ? aiUi.button({ kind: 'delete', text: '删除', onClick: () => void remove() }).element : null
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
      if (selection.type !== TYPE_TEXT && (!findItem(view, selection) || (selection.ref === NEW_REF && !view.actions.canEdit))) {
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
    approveNote: (view) => {
      const base = view.merged
        ? '确认后它将继续作为后续分镜脚本的依据。'
        : '确认后将把抽取的集和实体合并到作品：集按序号更新，实体按类型与名称合并并保留已有绑定，不再出现的实体会被停用；它也将作为后续分镜脚本的依据。';
      const blocked = view.blockedEpisodes || [];
      const removed = view.removedEpisodes || [];
      const downstream = (view.downstreamEpisodes || []).filter((seq) => !blocked.includes(seq));
      const notes = [base];
      if (downstream.length > 0) {
        notes.push(`第 ${downstream.join('、')} 集已有分镜脚本，确认后它们会显示“上游已变更”，不会自动更新。`);
      }
      if (removed.length > 0) {
        notes.push(`原有的第 ${removed.join('、')} 集在新版本中已不存在（不再属于剧本），确认后将被移除。`);
      }
      if (blocked.length > 0) {
        notes.push(
          `原有的第 ${blocked.join('、')} 集在新版本中已不存在（不再属于剧本），但已有分镜脚本、资产绑定或生成参数，不能直接移除，确认会被拒绝；请先在新版本中保留这些集。`
        );
      }
      return notes.join('');
    },
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
