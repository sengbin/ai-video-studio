// ------------------------------------------------------------------------
// 名称：stage-storyboard.js
// 说明：分镜脚本阶段的产出内容：左侧镜头列表、右侧镜头编辑区（画面、时长、首帧来源、出场实体、声音、提示词），以及生成结束后的汇总。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：向 stage.js 的外壳登记；请求名称与 src/app/pages/stage-handlers.ts、表单名称与 src/app/forms/storyboard-form.ts 一致；镜头的 ref 就是镜头标识，页面原样回传；支持在末尾新增和删除镜头，暂不支持调整镜头顺序。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_SAVE_SHOT = 'stage.saveShot';
  const REQUEST_ADD_SHOT = 'stage.addShot';
  const REQUEST_DELETE_SHOT = 'stage.deleteShot';
  const FORM_START = 'storyboard.start';
  const SAVE_TEXT = '保存';
  const ADD_TEXT = '添加';
  const SAVED_TEXT = '已保存';
  const SAVE_STATE_DIRTY = 'dirty';
  const SAVE_STATE_SAVED = 'saved';
  // 尚未保存的新镜头用这个标识。
  const NEW_SHOT = 'new';
  // 新镜头的默认时长（秒），生成时设了最短时长则取最短时长。
  const NEW_SHOT_SECONDS = 3;
  const BODY_MAX_ROWS = 6;
  const ACTION_PREVIEW_LENGTH = 24;
  const FIRST_FRAME_NONE = 'none';
  const FIRST_FRAME_PREV_TAIL = 'prev_tail';
  const SOUND_DIALOGUE = 'dialogue';
  const MAX_SOUNDS = 20;

  /** 截取动作文字用于列表显示。 */
  function preview(text) {
    return text.length > ACTION_PREVIEW_LENGTH ? `${text.slice(0, ACTION_PREVIEW_LENGTH)}…` : text;
  }

  /** 秒数显示：整数不带小数点。 */
  function formatSeconds(seconds) {
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} 秒`;
  }

  /** 可空的数字转为输入框文字。 */
  function numberText(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  /** 带标签的字段。 */
  function field(label, control, description) {
    return aiUi.field({ label, description, control }).element;
  }

  /**
   * 创建分镜脚本阶段的内容。
   * @param context 外壳提供的 { runAction, showMessage, reload, getView, confirmDiscard }。
   */
  function create(context) {
    /** 当前选中的镜头标识；为 null 时选第一个。 */
    let selectedId = null;
    /** 编辑器当前对应的“版本:镜头:权限”，用来判断切换后是否需要重建。 */
    let editorKey = '';
    /** 编辑器创建时镜头内容的快照，用于判断宿主数据是否变了。 */
    let editorSignature = '';
    let editorDirty = false;
    let editorControls = null;
    let bodyContainer = null;

    /** 生成结束后的汇总：镜头数、总时长、参数概要。 */
    function renderSummary(view) {
      if (view.shots.length === 0) return null;
      const params = view.params;
      const parts = [`共 ${view.shots.length} 个镜头，总时长 ${formatSeconds(view.totalSeconds)}。`];
      if (params) {
        const sound = params.audioMode === 'none' ? '无声' : '含声音条目';
        parts.push(`${sound}；镜头连贯：${{ none: '无', prev_tail: '尾帧接首帧', ai: '由 AI 判断' }[params.continuity] || ''}。`);
      }
      return aiUi.h('p', { class: 'description', text: parts.join('') });
    }

    /** 选择镜头；有未保存的修改时先确认。 */
    async function select(id) {
      if (id === selectedId) return;
      if (!(await context.confirmDiscard())) return;
      editorDirty = false;
      selectedId = id;
      renderBody(context.getView(), bodyContainer);
    }

    /** 左侧列表中的一个镜头。 */
    function renderItem(shot) {
      const isSelected = shot.id === selectedId;
      const meta = [shot.shotSize, formatSeconds(shot.durationSeconds), shot.sounds.length > 0 ? `${shot.sounds.length} 条声音` : ''].filter(Boolean);
      return aiUi.h(
        'button',
        {
          class: isSelected ? 'stage-item is-selected' : 'stage-item',
          attrs: { type: 'button', 'aria-current': isSelected ? 'true' : undefined },
          on: { click: () => void select(shot.id) }
        },
        aiUi.h('span', { class: 'stage-item__title', text: `${shot.seq}. ${preview(shot.action)}` }),
        aiUi.h('span', { class: 'stage-item__meta', text: meta.join(' · ') })
      );
    }

    /** 左侧列表：镜头；可编辑时标题行带“添加”按钮，新增中的镜头排在末尾。 */
    function renderList(view) {
      const isNew = selectedId === NEW_SHOT;
      return aiUi.h(
        'aside',
        { class: 'stage-list' },
        aiUi.h(
          'div',
          { class: 'stage-list__head' },
          aiUi.h('p', { class: 'stage-list__heading', text: `镜头（${view.shots.length}）` }),
          view.actions.canEdit ? aiUi.button({ kind: 'add', text: ADD_TEXT, compact: true, onClick: () => void select(NEW_SHOT) }).element : null
        ),
        view.shots.map(renderItem),
        isNew
          ? aiUi.h(
              'button',
              { class: 'stage-item is-selected', attrs: { type: 'button', 'aria-current': 'true' } },
              aiUi.h('span', { class: 'stage-item__title', text: `${view.shots.length + 1}. 新增镜头` }),
              aiUi.h('span', { class: 'stage-item__meta', text: '未保存' })
            )
          : null
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

    /** 一条声音的编辑行：类型、说话人、台词、说话方式、起止时间、启用、排序与删除。 */
    function createSoundRow(view, sound, canEdit, markDirty, actions) {
      const speakers = view.entities
        .filter((entity) => entity.kind === 'character')
        .map((entity) => ({ value: String(entity.id), label: entity.isActive ? entity.name : `${entity.name}（已停用）` }));
      const kind = aiUi.select({
        options: view.soundKinds.map((item) => ({ value: item.kind, label: item.label })),
        value: sound.kind,
        allowEmpty: false,
        ariaLabel: '声音类型',
        disabled: !canEdit,
        onChange: () => {
          updateSpeakerVisibility();
          markDirty();
        }
      });
      const speaker = aiUi.select({
        options: speakers,
        value: sound.speakerEntityId === null ? '' : String(sound.speakerEntityId),
        placeholder: '选择说话的角色',
        ariaLabel: '说话人',
        disabled: !canEdit,
        onChange: markDirty
      });
      const text = aiUi.textArea({ value: sound.text, minRows: 1, maxRows: 3, ariaLabel: '台词或声音描述', disabled: !canEdit, onChange: markDirty });
      const delivery = aiUi.textInput({ value: sound.delivery, placeholder: '说话方式或声音质感', ariaLabel: '说话方式或声音质感', disabled: !canEdit, onChange: markDirty });
      const start = aiUi.textInput({ value: numberText(sound.startOffsetSeconds), placeholder: '开始（秒）', ariaLabel: '开始时间（秒）', disabled: !canEdit, onChange: markDirty });
      const duration = aiUi.textInput({ value: numberText(sound.durationSeconds), placeholder: '时长（秒）', ariaLabel: '持续时长（秒）', disabled: !canEdit, onChange: markDirty });
      const enabled = aiUi.switchControl({ label: '启用', checked: sound.isEnabled, disabled: !canEdit, onChange: markDirty });

      const speakerSlot = aiUi.h('div', { class: 'stage-sound__speaker' }, speaker.element);
      /** 只有角色对白需要说话人。 */
      function updateSpeakerVisibility() {
        speakerSlot.hidden = kind.getValue() !== SOUND_DIALOGUE;
      }
      updateSpeakerVisibility();

      const moveUp = aiUi.button({ text: '上移', compact: true, disabled: !canEdit, onClick: () => actions.move(row, -1) });
      const moveDown = aiUi.button({ text: '下移', compact: true, disabled: !canEdit, onClick: () => actions.move(row, 1) });
      const remove = aiUi.button({ kind: 'delete', text: '删除', compact: true, disabled: !canEdit, onClick: () => actions.remove(row) });
      const element = aiUi.h(
        'div',
        { class: 'stage-sound' },
        aiUi.h('div', { class: 'stage-sound__line' }, aiUi.h('div', { class: 'stage-sound__kind' }, kind.element), speakerSlot, enabled.element),
        text.element,
        delivery.element,
        aiUi.h('div', { class: 'stage-sound__line' }, start.element, duration.element),
        canEdit ? aiUi.h('div', { class: 'stage-sound__line' }, moveUp.element, moveDown.element, remove.element) : null
      );
      const row = {
        element,
        moveUp,
        moveDown,
        collect: () => ({
          kind: kind.getValue(),
          speakerEntityId: kind.getValue() === SOUND_DIALOGUE && speaker.getValue() !== '' ? Number(speaker.getValue()) : null,
          text: text.getValue(),
          delivery: delivery.getValue(),
          startOffsetSeconds: start.getValue(),
          durationSeconds: duration.getValue(),
          isEnabled: enabled.getValue()
        })
      };
      return row;
    }

    /** 声音区：按行编辑，可添加、上移、下移、删除。 */
    function buildSounds(view, shot, canEdit, markDirty) {
      if (view.params && view.params.audioMode === 'none' && shot.sounds.length === 0) {
        return { element: aiUi.h('p', { class: 'description', text: '本次生成选择了“无声”，没有声音条目。' }), collect: () => [] };
      }
      const rows = [];
      const listElement = aiUi.h('div', { class: 'stage-sounds' });
      const addButton = aiUi.button({
        kind: 'add',
        text: '添加声音',
        compact: true,
        disabled: !canEdit,
        onClick: () => {
          if (rows.length >= MAX_SOUNDS) return;
          rows.push(createSoundRow(view, { kind: view.soundKinds[0].kind, speakerEntityId: null, text: '', delivery: '', startOffsetSeconds: null, durationSeconds: null, isEnabled: true }, canEdit, markDirty, actions));
          renderRows();
          markDirty();
        }
      });
      const actions = {
        move(row, offset) {
          const index = rows.indexOf(row);
          const target = index + offset;
          if (target < 0 || target >= rows.length) return;
          rows.splice(index, 1);
          rows.splice(target, 0, row);
          renderRows();
          markDirty();
        },
        remove(row) {
          rows.splice(rows.indexOf(row), 1);
          renderRows();
          markDirty();
        }
      };
      function renderRows() {
        listElement.textContent = '';
        if (rows.length === 0) listElement.append(aiUi.h('p', { class: 'description', text: '这个镜头没有声音。' }));
        rows.forEach((row, index) => {
          row.moveUp.setDisabled(!canEdit || index === 0);
          row.moveDown.setDisabled(!canEdit || index === rows.length - 1);
          listElement.append(row.element);
        });
        addButton.setDisabled(!canEdit || rows.length >= MAX_SOUNDS);
      }
      for (const sound of shot.sounds) rows.push(createSoundRow(view, sound, canEdit, markDirty, actions));
      renderRows();
      return {
        element: aiUi.h('div', { class: 'stage-sounds-area' }, listElement, canEdit ? addButton.element : null),
        collect: () => rows.map((row) => row.collect())
      };
    }

    /** 镜头编辑：画面与动作、时长、景别等、首帧来源、出场实体、声音、提示词。 */
    function buildShotEditor(view, shot, canEdit, markDirty) {
      const action = aiUi.textArea({ value: shot.action, minRows: 2, maxRows: BODY_MAX_ROWS, disabled: !canEdit, onChange: markDirty });
      const duration = aiUi.textInput({ value: numberText(shot.durationSeconds), disabled: !canEdit, onChange: markDirty });
      const sceneLabel = aiUi.textInput({ value: shot.sceneLabel, disabled: !canEdit, onChange: markDirty });
      const shotSize = aiUi.textInput({ value: shot.shotSize, disabled: !canEdit, onChange: markDirty });
      const cameraAngle = aiUi.textInput({ value: shot.cameraAngle, disabled: !canEdit, onChange: markDirty });
      const cameraMovement = aiUi.textInput({ value: shot.cameraMovement, disabled: !canEdit, onChange: markDirty });
      const transition = aiUi.textInput({ value: shot.transition, disabled: !canEdit, onChange: markDirty });
      const continuityNote = aiUi.textArea({ value: shot.continuityNote, minRows: 1, maxRows: 3, disabled: !canEdit, onChange: markDirty });
      const firstFrameOptions = [{ value: FIRST_FRAME_NONE, label: '不指定' }];
      // 第 1 个镜头没有上一镜头；指定资产图的首帧随资产管理实现。
      if (shot.seq > 1) firstFrameOptions.push({ value: FIRST_FRAME_PREV_TAIL, label: '上一镜头尾帧' });
      const firstFrame = aiUi.select({
        options: firstFrameOptions,
        value: shot.firstFrameMode === FIRST_FRAME_PREV_TAIL && shot.seq > 1 ? FIRST_FRAME_PREV_TAIL : FIRST_FRAME_NONE,
        allowEmpty: false,
        ariaLabel: '首帧来源',
        disabled: !canEdit,
        onChange: markDirty
      });
      const entities = aiUi.checkboxGroup({
        options: view.entities.map((entity) => ({
          value: String(entity.id),
          label: `[${entity.kindLabel}] ${entity.name}${entity.isActive ? '' : '（已停用）'}`
        })),
        value: shot.entityIds.map(String),
        ariaLabel: '出场实体',
        disabled: !canEdit,
        onChange: markDirty
      });
      const sounds = buildSounds(view, shot, canEdit, markDirty);
      const promptZh = aiUi.textArea({ value: shot.promptZh, minRows: 2, maxRows: BODY_MAX_ROWS, disabled: !canEdit, onChange: markDirty });
      const promptEn = aiUi.textArea({ value: shot.promptEn, minRows: 2, maxRows: BODY_MAX_ROWS, disabled: !canEdit, onChange: markDirty });

      return {
        fields: [
          field('画面与动作', action),
          field('时长（秒）', duration, '大于 0，最多 1 位小数'),
          field('场次', sceneLabel),
          field('景别', shotSize),
          field('机位与视角', cameraAngle),
          field('摄影机运动', cameraMovement),
          field('转场', transition),
          field('连续性要求', continuityNote),
          field('首帧来源', firstFrame, '以上一镜头尾帧为首帧时，需要等上一镜头生成完成'),
          field('出场实体', entities, '对白的说话人会自动加入出场实体'),
          aiUi.h('div', { class: 'ui-field' }, aiUi.h('div', { class: 'ui-field__label', text: '声音' }), sounds.element),
          field('中文提示词', promptZh),
          field('英文提示词', promptEn)
        ],
        collect: () => ({
          action: action.getValue(),
          durationSeconds: duration.getValue(),
          sceneLabel: sceneLabel.getValue(),
          shotSize: shotSize.getValue(),
          cameraAngle: cameraAngle.getValue(),
          cameraMovement: cameraMovement.getValue(),
          transition: transition.getValue(),
          continuityNote: continuityNote.getValue(),
          firstFrameMode: firstFrame.getValue(),
          entityIds: entities.getValue().map(Number),
          sounds: sounds.collect(),
          promptZh: promptZh.getValue(),
          promptEn: promptEn.getValue()
        })
      };
    }

    /** 保存当前镜头（新增中的镜头则添加）；已确认的版本被编辑时先提示会回到待确认。 */
    async function save() {
      const view = context.getView();
      const isNew = selectedId === NEW_SHOT;
      if (view.actions.editNeedsConfirm) {
        const confirmed = await aiUi.confirm({
          title: isNew ? '添加镜头' : '保存修改',
          message: `该版本已确认采用。${isNew ? '添加' : '保存'}后将回到待确认，需要重新确认。`,
          confirmText: isNew ? '添加' : '保存',
          cancelText: '取消'
        });
        if (!confirmed) return;
      }
      const { built } = editorControls;
      const payload = { id: view.run.id, ...built.collect() };
      if (!isNew) payload.ref = selectedId;
      const result = await context.runAction(isNew ? REQUEST_ADD_SHOT : REQUEST_SAVE_SHOT, payload);
      if (result) {
        editorDirty = false;
        // 新增成功后选中刚加入的镜头。
        if (isNew) selectedId = result.ref;
        await context.reload();
        // 重新加载后编辑区会按最新内容重建，按钮状态要在重建后再设置。
        if (editorControls) editorControls.setSaveState(SAVE_STATE_SAVED);
        context.showMessage(isNew ? '已添加。' : '已保存。', false);
      }
    }

    /** 删除当前镜头；先确认，并说明影响范围。 */
    async function remove() {
      const view = context.getView();
      const shot = view.shots.find((candidate) => candidate.id === selectedId);
      const lines = [`删除第 ${shot.seq} 个镜头及其声音后，后面的镜头序号会前移。`];
      if (view.actions.editNeedsConfirm) lines.push('该版本已确认采用，删除后将回到待确认。');
      const confirmed = await aiUi.confirm({ title: '删除镜头', message: lines, confirmText: '删除', variant: 'danger' });
      if (!confirmed) return;
      if (await context.runAction(REQUEST_DELETE_SHOT, { id: view.run.id, ref: shot.id })) {
        editorDirty = false;
        selectedId = null;
        await context.reload();
        context.showMessage('已删除。', false);
      }
    }

    /** 新增镜头的空白内容：接在末尾，默认不指定首帧。 */
    function blankShot(view) {
      return {
        id: NEW_SHOT,
        seq: view.shots.length + 1,
        sceneLabel: '',
        shotSize: '',
        cameraAngle: '',
        action: '',
        cameraMovement: '',
        durationSeconds: (view.params && view.params.minShotSeconds) || NEW_SHOT_SECONDS,
        transition: '',
        continuityNote: '',
        firstFrameMode: FIRST_FRAME_NONE,
        entityIds: [],
        sounds: [],
        promptZh: '',
        promptEn: ''
      };
    }

    /** 右侧编辑区：切换镜头时重建；同一镜头有未保存的修改时保留输入。 */
    function renderEditor(view, shot) {
      const canEdit = view.actions.canEdit;
      const isNew = shot.id === NEW_SHOT;
      const key = `${view.run.id}:${shot.id}:${canEdit}:${view.actions.editNeedsConfirm}`;
      const signature = JSON.stringify(shot);
      if (editorControls && editorKey === key && (editorDirty || editorSignature === signature)) return editorControls.element;

      editorKey = key;
      editorSignature = signature;
      editorDirty = false;
      const saveButton = aiUi.button({ text: isNew ? ADD_TEXT : SAVE_TEXT, variant: 'primary', disabled: !isNew, onClick: () => void save() });
      /** 保存按钮只在有修改时可点，保存后显示“已保存”，再次修改后恢复；新增的镜头始终可点“添加”。 */
      const setSaveState = (state) => {
        saveButton.setText(state === SAVE_STATE_SAVED ? SAVED_TEXT : isNew ? ADD_TEXT : SAVE_TEXT);
        saveButton.setDisabled(!isNew && state !== SAVE_STATE_DIRTY);
      };
      const markDirty = () => {
        editorDirty = true;
        setSaveState(SAVE_STATE_DIRTY);
      };

      const built = buildShotEditor(view, shot, canEdit, markDirty);
      const reason = readonlyReason(view);
      // 至少保留 1 个镜头。
      const canRemove = canEdit && !isNew && view.shots.length > 1;
      const element = aiUi.h(
        'section',
        { class: 'stage-editor stage-editor--fields' },
        built.fields,
        reason ? aiUi.h('p', { class: 'description', text: reason }) : null,
        canEdit
          ? aiUi.h(
              'div',
              { class: 'stage-editor__actions' },
              saveButton.element,
              canRemove ? aiUi.button({ kind: 'delete', text: '删除', onClick: () => void remove() }).element : null
            )
          : null
      );
      editorControls = { element, built, setSaveState };
      return element;
    }

    /** 主体：左侧镜头列表与右侧编辑区；还没有镜头时给出说明。 */
    function renderBody(view, container) {
      bodyContainer = container;
      container.textContent = '';
      if (view.shots.length === 0) {
        editorControls = null;
        editorKey = '';
        container.append(aiUi.h('p', { class: 'description', text: '分镜脚本生成完成后，镜头会显示在这里。' }));
        return;
      }
      const keepsNew = selectedId === NEW_SHOT && view.actions.canEdit;
      if (!keepsNew && !view.shots.some((shot) => shot.id === selectedId)) {
        selectedId = view.shots[0].id;
        editorDirty = false;
      }
      const shot = selectedId === NEW_SHOT ? blankShot(view) : view.shots.find((candidate) => candidate.id === selectedId);
      container.append(renderList(view), aiUi.h('div', { class: 'stage-detail' }, renderEditor(view, shot)));
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
    stage: 'storyboard_script',
    label: '分镜脚本',
    regenerateForm: FORM_START,
    keptNote: '本集已保存的内容不受影响',
    discardMessage: '当前镜头有未保存的修改，放弃这些修改？',
    approveNote: () => '确认后它将作为这一集后续制作（资产绑定、视频生成）的依据。',
    titleSuffix: (view) => ` › 第 ${view.episode.seq} 集`,
    create
  });
})();
