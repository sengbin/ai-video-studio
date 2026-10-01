// ------------------------------------------------------------------------
// 名称：stage-creative.js
// 说明：创意阶段的产出内容：左侧章节列表、右侧章节标题与正文编辑、按章保存，以及生成结束后的字数汇总。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-10-02
// 备注：向 stage.js 的外壳登记；请求名称与 src/app/pages/stage-handlers.ts、重新生成表单名称与 src/app/forms/work-form.ts 一致。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const REQUEST_SAVE_CHAPTER = 'stage.saveChapter';
  const FORM_REGENERATE = 'work.regenerate';
  const SAVE_TEXT = '保存本章';
  const SAVED_TEXT = '已保存';
  const SAVE_STATE_DIRTY = 'dirty';
  const SAVE_STATE_SAVED = 'saved';
  // 正文按内容增高，最多长到这个行数再滚动（与阶段页的编辑区高度相当）。
  const BODY_MAX_ROWS = 20;

  /**
   * 创建创意阶段的内容。
   * @param context 外壳提供的 { runAction, showMessage, reload, getView, confirmDiscard }。
   */
  function create(context) {
    let selectedSeq = null;
    /** 编辑器当前对应的“版本:章节”，用来判断切换后是否需要重建。 */
    let editorKey = '';
    let editorDirty = false;
    let editorControls = null;
    let bodyContainer = null;

    /** 章节字数提示：与设定的大约范围比较，给出文字说明。 */
    function wordHintText(view, chapter) {
      if (!view.params) return '';
      const { chapterMinWords, chapterMaxWords } = view.params;
      if (chapter.wordHint === 'short') return `比设定的约 ${chapterMinWords} 字少 ${chapterMinWords - chapter.wordCount} 字`;
      if (chapter.wordHint === 'long') return `比设定的约 ${chapterMaxWords} 字多 ${chapter.wordCount - chapterMaxWords} 字`;
      return '';
    }

    /** 生成结束后的字数汇总：设定的大约范围与实际字数；不在范围内时说明原因。 */
    function renderSummary(view) {
      const { params, chapters, totalWords } = view;
      if (!params || chapters.length === 0) return null;
      const range = `每章约 ${params.chapterMinWords} 到 ${params.chapterMaxWords} 字`;
      const outOfRange = chapters.filter((chapter) => chapter.wordHint);
      if (outOfRange.length === 0) {
        return aiUi.h('p', {
          class: 'description',
          text: `字数：设定${range}，实际共 ${chapters.length} 章 ${totalWords} 字，各章均在范围内。`
        });
      }
      const listed = outOfRange.slice(0, 5).map((chapter) => `第 ${chapter.seq} 章 ${chapter.wordCount} 字`).join('、');
      const more = outOfRange.length > 5 ? `（共 ${outOfRange.length} 章）` : '';
      return aiUi.h('p', {
        class: 'status-warning',
        text:
          `字数提示：设定${range}，实际有 ${outOfRange.length} 章不在该范围：${listed}${more}。` +
          '原因：Copilot 会根据内容的实际情况决定篇幅，不一定严格遵守设定字数。生成结果已全部保留，可直接编辑调整。'
      });
    }

    /** 选择章节；有未保存的修改时先确认。 */
    async function selectChapter(seq) {
      if (seq === selectedSeq) return;
      if (!(await context.confirmDiscard())) return;
      editorDirty = false;
      selectedSeq = seq;
      renderBody(context.getView(), bodyContainer);
    }

    /** 保存当前章节；已确认的版本被编辑时先提示会回到待确认。 */
    async function saveChapter() {
      const view = context.getView();
      const { title, content } = editorControls;
      if (view.actions.editNeedsConfirm) {
        const confirmed = await aiUi.confirm({
          title: '保存修改',
          message: '该版本已确认采用。保存后将回到待确认，需要重新确认。',
          confirmText: '保存',
          cancelText: '取消'
        });
        if (!confirmed) return;
      }
      const result = await context.runAction(REQUEST_SAVE_CHAPTER, {
        id: view.run.id,
        seq: selectedSeq,
        title: title.getValue(),
        content: content.getValue()
      });
      if (result) {
        editorDirty = false;
        await context.reload();
        // 重新加载后编辑区可能被重建（如已确认的版本保存后回到待确认），按钮状态要在重建后再设置。
        if (editorControls) editorControls.setSaveState(SAVE_STATE_SAVED);
        context.showMessage('已保存。', false);
      }
    }

    /** 章节列表：标题、字数与字数提示；当前章节高亮。 */
    function renderChapterList(view) {
      const { chapters, totalWords } = view;
      const items = chapters.map((chapter) => {
        const hint = wordHintText(view, chapter);
        const isSelected = chapter.seq === selectedSeq;
        return aiUi.h(
          'button',
          {
            class: isSelected ? 'stage-item is-selected' : 'stage-item',
            attrs: { type: 'button', 'aria-current': isSelected ? 'true' : undefined },
            on: { click: () => void selectChapter(chapter.seq) }
          },
          aiUi.h('span', { class: 'stage-item__title', text: `${chapter.seq}. ${chapter.title}` }),
          aiUi.h('span', { class: 'stage-item__meta', text: `${chapter.wordCount} 字` }),
          hint ? aiUi.h('span', { class: 'stage-item__hint status-warning', text: hint }) : null
        );
      });
      return aiUi.h(
        'aside',
        { class: 'stage-list' },
        aiUi.h('p', { class: 'description', text: `共 ${chapters.length} 章，共 ${totalWords} 字` }),
        chapters.length === 0 ? aiUi.h('p', { class: 'description', text: '章节生成后会陆续显示在这里。' }) : null,
        items
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

    /** 章节编辑区：切换章节时重建；同一章节有未保存的修改时保留输入。 */
    function renderEditor(view, chapter) {
      const key = `${view.run.id}:${chapter.seq}:${view.actions.canEdit}:${view.actions.editNeedsConfirm}`;
      if (editorControls && editorKey === key) {
        if (!editorDirty) {
          editorControls.title.setValue(chapter.title);
          editorControls.content.setValue(chapter.content);
        }
        return editorControls.element;
      }

      editorKey = key;
      editorDirty = false;
      const markDirty = () => {
        editorDirty = true;
        setSaveState(SAVE_STATE_DIRTY);
      };
      const canEdit = view.actions.canEdit;
      const title = aiUi.textInput({ value: chapter.title, ariaLabel: '章节标题', disabled: !canEdit, onChange: markDirty });
      const content = aiUi.textArea({ value: chapter.content, ariaLabel: '章节正文', maxRows: BODY_MAX_ROWS, disabled: !canEdit, onChange: markDirty });
      const reason = readonlyReason(view);
      const saveButton = aiUi.button({ text: SAVE_TEXT, variant: 'primary', disabled: true, onClick: () => void saveChapter() });
      /** 保存按钮只在有修改时可点，保存后显示“已保存”，再次修改后恢复。 */
      const setSaveState = (state) => {
        saveButton.setText(state === SAVE_STATE_SAVED ? SAVED_TEXT : SAVE_TEXT);
        saveButton.setDisabled(state !== SAVE_STATE_DIRTY);
      };

      const element = aiUi.h(
        'section',
        { class: 'stage-editor' },
        aiUi.h('div', { class: 'stage-editor__title' }, title.element),
        aiUi.h('div', { class: 'stage-editor__content' }, content.element),
        reason ? aiUi.h('p', { class: 'description', text: reason }) : null,
        canEdit ? aiUi.h('div', { class: 'stage-editor__actions' }, saveButton.element) : null
      );
      editorControls = { key, element, title, content, setSaveState };
      return element;
    }

    /** 主体：章节列表与编辑区。 */
    function renderBody(view, container) {
      bodyContainer = container;
      container.textContent = '';
      const { chapters } = view;
      if (chapters.length === 0) {
        editorControls = null;
        editorKey = '';
        container.append(renderChapterList(view));
        return;
      }
      if (!chapters.some((chapter) => chapter.seq === selectedSeq)) selectedSeq = chapters[0].seq;
      const chapter = chapters.find((item) => item.seq === selectedSeq);
      const wordHint = wordHintText(view, chapter);
      container.append(
        renderChapterList(view),
        aiUi.h(
          'div',
          { class: 'stage-detail' },
          aiUi.h('p', { class: 'description', text: `本章 ${chapter.wordCount} 字${wordHint ? `（${wordHint}）` : ''}` }),
          renderEditor(view, chapter)
        )
      );
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
    stage: 'creative',
    label: '创意',
    regenerateForm: FORM_REGENERATE,
    keptNote: '已完成的章节已保留',
    discardMessage: '当前章节有未保存的修改，放弃这些修改？',
    approveNote: () => '确认后它将作为后续剧本阶段的依据。',
    create
  });
})();
