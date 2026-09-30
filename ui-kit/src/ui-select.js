// ------------------------------------------------------------------------
// 名称：ui-select.js
// 说明：界面组件库的下拉列表：自绘触发器与选项弹层，支持键盘操作、可选空项和“其他（手动输入）”。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js、ui-input-controls.js；弹层放在全页层容器中，不被对话框或表格裁切。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  const CUSTOM_VALUE = '__custom__';
  const DEFAULT_PLACEHOLDER = '请选择';
  const DEFAULT_CUSTOM_LABEL = '其他（手动输入）';
  const DEFAULT_CUSTOM_PLACEHOLDER = '请输入';
  const MAX_POPUP_HEIGHT = 240;
  const POPUP_GAP = 2;
  const VIEWPORT_MARGIN = 8;

  /**
   * 创建下拉列表。
   * @param {{ id?: string, options: Array<string|{ value: string, label?: string }>, value?: string, placeholder?: string,
   *   allowEmpty?: boolean, allowCustom?: boolean, customLabel?: string, customPlaceholder?: string, ariaLabel?: string,
   *   disabled?: boolean, onChange?: (value: string) => void }} options 选项：
   *   allowEmpty 默认 true，在列表最前提供“请选择”以清空；allowCustom 为 true 时在末尾提供“其他（手动输入）”，
   *   选中后出现输入框，getValue 返回输入的文本。
   * @returns 控件对象，getValue 返回所选值（未选为空串）。
   */
  aiUi.select = function (options) {
    const settings = options || {};
    const items = aiUi.normalizeOptions(settings.options || []);
    const allowEmpty = settings.allowEmpty !== false;
    const placeholder = settings.placeholder || DEFAULT_PLACEHOLDER;
    const customLabel = settings.customLabel || DEFAULT_CUSTOM_LABEL;

    const entries = [];
    if (allowEmpty) entries.push({ value: '', label: placeholder, isPlaceholder: true });
    entries.push(...items);
    if (settings.allowCustom) entries.push({ value: CUSTOM_VALUE, label: customLabel });

    const listboxId = aiUi.uid('ui-listbox');
    let selectedValue = '';
    let isOpen = false;
    let activeIndex = -1;
    let popup = null;

    const valueText = aiUi.h('span', { class: 'ui-select__value' });
    const trigger = aiUi.h(
      'button',
      {
        class: 'ui-select__trigger',
        attrs: {
          type: 'button',
          role: 'combobox',
          id: settings.id,
          'aria-haspopup': 'listbox',
          'aria-expanded': 'false',
          'aria-controls': listboxId,
          'aria-label': settings.ariaLabel
        }
      },
      valueText
    );

    const customInput = settings.allowCustom
      ? aiUi.textInput({
          ariaLabel: settings.ariaLabel ? `${settings.ariaLabel}（手动输入）` : '手动输入',
          placeholder: settings.customPlaceholder || DEFAULT_CUSTOM_PLACEHOLDER,
          onChange: () => control.notifyChange()
        })
      : null;
    if (customInput) {
      customInput.element.classList.add('ui-select__custom');
      customInput.element.hidden = true;
    }
    const element = aiUi.h('div', { class: 'ui-select' }, trigger, customInput && customInput.element);

    /** 按当前选中项刷新触发器文字与自定义输入框的显示。 */
    function refresh() {
      const entry = entries.find((candidate) => candidate.value === selectedValue);
      const showsPlaceholder = selectedValue === '';
      valueText.textContent = showsPlaceholder ? placeholder : entry ? entry.label : selectedValue;
      valueText.classList.toggle('ui-select__value--placeholder', showsPlaceholder);
      if (customInput) customInput.element.hidden = selectedValue !== CUSTOM_VALUE;
    }

    function setSelected(value, shouldNotify) {
      selectedValue = value;
      refresh();
      if (shouldNotify) control.notifyChange();
    }

    /** 高亮某一项并滚动到可见，同步 aria-activedescendant。 */
    function setActive(index) {
      if (popup === null) return;
      const optionElements = popup.children;
      if (activeIndex >= 0 && optionElements[activeIndex]) optionElements[activeIndex].classList.remove('is-active');
      activeIndex = index;
      const active = optionElements[index];
      if (!active) return;
      active.classList.add('is-active');
      trigger.setAttribute('aria-activedescendant', active.id);
      active.scrollIntoView({ block: 'nearest' });
    }

    /** 定位弹层：默认在触发器下方，下方空间不足且上方更宽裕时翻到上方。 */
    function positionPopup() {
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - VIEWPORT_MARGIN;
      const wanted = Math.min(popup.scrollHeight, MAX_POPUP_HEIGHT);
      const placeBelow = spaceBelow >= wanted || spaceBelow >= spaceAbove;
      const maxHeight = Math.max(Math.min(MAX_POPUP_HEIGHT, placeBelow ? spaceBelow : spaceAbove), 0);
      popup.style.left = `${rect.left}px`;
      popup.style.width = `${rect.width}px`;
      popup.style.maxHeight = `${maxHeight}px`;
      const height = Math.min(popup.scrollHeight, maxHeight);
      popup.style.top = `${placeBelow ? rect.bottom + POPUP_GAP : rect.top - POPUP_GAP - height}px`;
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      popup.remove();
      popup = null;
      activeIndex = -1;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.removeAttribute('aria-activedescendant');
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    }

    function open() {
      if (isOpen || trigger.disabled || entries.length === 0) return;
      popup = aiUi.h('div', { class: 'ui-select__popup', attrs: { role: 'listbox', id: listboxId } });
      entries.forEach((entry, index) => {
        popup.append(
          aiUi.h('div', {
            class: entry.isPlaceholder ? 'ui-select__option ui-select__option--placeholder' : 'ui-select__option',
            text: entry.label,
            attrs: { role: 'option', id: `${listboxId}-${index}`, 'aria-selected': String(entry.value === selectedValue) },
            on: {
              // 阻止按下时抢走触发器的焦点，避免弹层在点击前被失焦关闭。
              mousedown: (event) => event.preventDefault(),
              mousemove: () => setActive(index),
              click: () => choose(index)
            }
          })
        );
      });
      aiUi.layer().append(popup);
      isOpen = true;
      trigger.setAttribute('aria-expanded', 'true');
      positionPopup();
      const selectedIndex = entries.findIndex((entry) => entry.value === selectedValue);
      setActive(selectedIndex >= 0 ? selectedIndex : 0);
      window.addEventListener('resize', close);
      window.addEventListener('scroll', close, true);
    }

    function choose(index) {
      const entry = entries[index];
      close();
      setSelected(entry.value, true);
      if (entry.value === CUSTOM_VALUE && customInput) customInput.focus();
      else trigger.focus();
    }

    function moveActive(delta) {
      setActive((activeIndex + delta + entries.length) % entries.length);
    }

    trigger.addEventListener('click', () => (isOpen ? close() : open()));
    trigger.addEventListener('blur', close);
    trigger.addEventListener('keydown', (event) => {
      if (!isOpen) {
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
          event.preventDefault();
          open();
        }
        return;
      }
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveActive(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveActive(-1);
          break;
        case 'Home':
          event.preventDefault();
          setActive(0);
          break;
        case 'End':
          event.preventDefault();
          setActive(entries.length - 1);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          choose(activeIndex);
          break;
        case 'Escape':
          // 只关闭弹层，阻止对话框把这次 Esc 当作关闭对话框。
          event.preventDefault();
          close();
          break;
        case 'Tab':
          close();
          break;
        default:
          break;
      }
    });

    const control = aiUi.makeControl({
      element,
      focusTarget: trigger,
      invalidTarget: trigger,
      onChange: settings.onChange,
      getValue: () => (selectedValue === CUSTOM_VALUE && customInput ? customInput.getValue() : selectedValue),
      setValue: (value) => {
        const text = value === undefined || value === null ? '' : String(value);
        if (text === '') {
          selectedValue = '';
        } else if (items.some((item) => item.value === text)) {
          selectedValue = text;
        } else if (customInput) {
          selectedValue = CUSTOM_VALUE;
          customInput.setValue(text);
        } else {
          selectedValue = '';
        }
        refresh();
      },
      setDisabled: (disabled) => {
        trigger.disabled = disabled;
        if (disabled) close();
        if (customInput) customInput.setDisabled(disabled);
      }
    });

    control.setDisabled(Boolean(settings.disabled));
    control.setValue(settings.value);
    return control;
  };
})();
