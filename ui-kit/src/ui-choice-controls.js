// ------------------------------------------------------------------------
// 名称：ui-choice-controls.js
// 说明：界面组件库的选择类控件：单选组、复选框、复选框组和开关。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js；均按 ARIA 语义实现并支持键盘操作。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  const KEY_SPACE = ' ';
  const PREVIOUS_KEYS = ['ArrowUp', 'ArrowLeft'];
  const NEXT_KEYS = ['ArrowDown', 'ArrowRight'];

  /** 单选与复选的组容器类名，按排列方向区分。 */
  function groupClass(direction) {
    return direction === 'horizontal' ? 'ui-choice-group ui-choice-group--horizontal' : 'ui-choice-group';
  }

  /**
   * 创建一个选项元素（单选点或复选框），带标记和文字。
   * @param {'radio'|'checkbox'} role ARIA 角色。
   * @param {string} label 选项文字。
   */
  function createChoiceElement(role, label) {
    const mark = aiUi.h('span', { class: `ui-choice__mark ui-choice__mark--${role}`, attrs: { 'aria-hidden': 'true' } });
    const text = aiUi.h('span', { class: 'ui-choice__label', text: label });
    return aiUi.h('div', { class: 'ui-choice', attrs: { role, tabindex: '-1', 'aria-checked': 'false' } }, mark, text);
  }

  /** 设置选项元素的选中状态。 */
  function setChoiceChecked(element, checked) {
    element.setAttribute('aria-checked', String(checked));
  }

  /** 设置选项元素的禁用状态。 */
  function setChoiceDisabled(element, disabled) {
    element.setAttribute('aria-disabled', String(disabled));
  }

  /** 选项元素是否被禁用。 */
  function isChoiceDisabled(element) {
    return element.getAttribute('aria-disabled') === 'true';
  }

  /**
   * 创建单选组。
   * @param {{ options: Array<string|{ value: string, label?: string }>, value?: string, direction?: 'vertical'|'horizontal',
   *   ariaLabel?: string, disabled?: boolean, onChange?: (value: string) => void }} options 选项，direction 默认 vertical。
   * @returns 控件对象，getValue 返回所选值（未选为空串）。
   */
  aiUi.radioGroup = function (options) {
    const settings = options || {};
    const items = aiUi.normalizeOptions(settings.options || []);
    const radios = items.map((item) => ({ item, element: createChoiceElement('radio', item.label) }));
    const root = aiUi.h(
      'div',
      { class: groupClass(settings.direction), attrs: { role: 'radiogroup', 'aria-label': settings.ariaLabel } },
      radios.map((radio) => radio.element)
    );
    let selectedValue = '';
    let isDisabled = Boolean(settings.disabled);

    /** 可用 Tab 到达的那一个：已选中的，否则第一个。 */
    function tabbableRadio() {
      return radios.find((radio) => radio.item.value === selectedValue) || radios[0];
    }

    function refresh() {
      const tabbable = tabbableRadio();
      for (const radio of radios) {
        setChoiceChecked(radio.element, radio.item.value === selectedValue);
        setChoiceDisabled(radio.element, isDisabled);
        radio.element.tabIndex = radio === tabbable && !isDisabled ? 0 : -1;
      }
    }

    function select(index) {
      if (isDisabled) return;
      const changed = radios[index].item.value !== selectedValue;
      selectedValue = radios[index].item.value;
      refresh();
      if (changed) control.notifyChange();
    }

    radios.forEach((radio, index) => {
      radio.element.addEventListener('click', () => {
        select(index);
        radio.element.focus();
      });
      radio.element.addEventListener('keydown', (event) => {
        if (event.key === KEY_SPACE || event.key === 'Enter') {
          event.preventDefault();
          select(index);
        } else if (PREVIOUS_KEYS.includes(event.key) || NEXT_KEYS.includes(event.key)) {
          event.preventDefault();
          const step = NEXT_KEYS.includes(event.key) ? 1 : -1;
          const next = (index + step + radios.length) % radios.length;
          select(next);
          radios[next].element.focus();
        }
      });
    });

    const control = aiUi.makeControl({
      element: root,
      focusTarget: radios.length > 0 ? radios[0].element : root,
      ariaTarget: root,
      onChange: settings.onChange,
      getValue: () => selectedValue,
      setValue: (value) => {
        const text = value === undefined || value === null ? '' : String(value);
        selectedValue = items.some((item) => item.value === text) ? text : '';
        refresh();
      },
      setDisabled: (disabled) => {
        isDisabled = disabled;
        refresh();
      }
    });
    control.focus = () => {
      if (radios.length > 0) tabbableRadio().element.focus();
    };
    control.setDisabled(Boolean(settings.disabled));
    control.setValue(settings.value);
    return control;
  };

  /**
   * 为一个选项元素绑定“点击或空格切换”行为。
   * @param {HTMLElement} element 选项元素。
   * @param {() => void} toggle 切换函数。
   */
  function bindToggle(element, toggle) {
    element.addEventListener('click', () => {
      toggle();
      element.focus();
    });
    element.addEventListener('keydown', (event) => {
      if (event.key === KEY_SPACE) {
        event.preventDefault();
        toggle();
      }
    });
  }

  /**
   * 创建单个复选框。
   * @param {{ id?: string, label: string, checked?: boolean, disabled?: boolean, ariaLabel?: string,
   *   onChange?: (checked: boolean) => void }} options 选项。
   * @returns 控件对象，getValue 返回布尔值。
   */
  aiUi.checkbox = function (options) {
    const settings = options || {};
    const element = createChoiceElement('checkbox', settings.label || '');
    if (settings.id) element.id = settings.id;
    if (settings.ariaLabel) element.setAttribute('aria-label', settings.ariaLabel);
    let isChecked = false;

    const control = aiUi.makeControl({
      element,
      focusTarget: element,
      onChange: settings.onChange,
      getValue: () => isChecked,
      setValue: (value) => {
        isChecked = Boolean(value);
        setChoiceChecked(element, isChecked);
      },
      setDisabled: (disabled) => {
        setChoiceDisabled(element, disabled);
        element.tabIndex = disabled ? -1 : 0;
      }
    });
    bindToggle(element, () => {
      if (isChoiceDisabled(element)) return;
      control.setValue(!isChecked);
      control.notifyChange();
    });
    control.setDisabled(Boolean(settings.disabled));
    control.setValue(settings.checked);
    return control;
  };

  /**
   * 创建复选框组（多选）。
   * @param {{ options: Array<string|{ value: string, label?: string }>, value?: string[], direction?: 'vertical'|'horizontal',
   *   ariaLabel?: string, disabled?: boolean, onChange?: (value: string[]) => void }} options 选项。
   * @returns 控件对象，getValue 返回按选项顺序排列的已选值数组。
   */
  aiUi.checkboxGroup = function (options) {
    const settings = options || {};
    const items = aiUi.normalizeOptions(settings.options || []);
    const boxes = items.map((item) => ({ item, checked: false, element: createChoiceElement('checkbox', item.label) }));
    const root = aiUi.h(
      'div',
      { class: groupClass(settings.direction), attrs: { role: 'group', 'aria-label': settings.ariaLabel } },
      boxes.map((box) => box.element)
    );

    function selectedValues() {
      return boxes.filter((box) => box.checked).map((box) => box.item.value);
    }

    function setDisabledAll(disabled) {
      for (const box of boxes) {
        setChoiceDisabled(box.element, disabled);
        box.element.tabIndex = disabled ? -1 : 0;
      }
    }

    const control = aiUi.makeControl({
      element: root,
      focusTarget: boxes.length > 0 ? boxes[0].element : root,
      ariaTarget: root,
      onChange: settings.onChange,
      getValue: selectedValues,
      setValue: (value) => {
        const chosen = new Set(Array.isArray(value) ? value : []);
        for (const box of boxes) {
          box.checked = chosen.has(box.item.value);
          setChoiceChecked(box.element, box.checked);
        }
      },
      setDisabled: setDisabledAll
    });
    for (const box of boxes) {
      bindToggle(box.element, () => {
        if (isChoiceDisabled(box.element)) return;
        box.checked = !box.checked;
        setChoiceChecked(box.element, box.checked);
        control.notifyChange();
      });
    }
    control.setDisabled(Boolean(settings.disabled));
    control.setValue(settings.value);
    return control;
  };

  /**
   * 创建开关：左侧文字，右侧滑动开关。
   * @param {{ id?: string, label: string, checked?: boolean, disabled?: boolean,
   *   onChange?: (checked: boolean) => void }} options 选项。
   * @returns 控件对象，getValue 返回布尔值。
   */
  aiUi.switchControl = function (options) {
    const settings = options || {};
    const labelId = aiUi.uid('ui-switch-label');
    const thumb = aiUi.h('span', { class: 'ui-switch__thumb', attrs: { 'aria-hidden': 'true' } });
    const track = aiUi.h(
      'button',
      {
        class: 'ui-switch',
        attrs: { type: 'button', role: 'switch', id: settings.id, 'aria-checked': 'false', 'aria-labelledby': labelId }
      },
      thumb
    );
    const label = aiUi.h('span', { class: 'ui-switch-row__label', text: settings.label || '', attrs: { id: labelId } });
    const element = aiUi.h('div', { class: 'ui-switch-row' }, label, track);
    let isChecked = false;

    const control = aiUi.makeControl({
      element,
      focusTarget: track,
      invalidTarget: track,
      onChange: settings.onChange,
      getValue: () => isChecked,
      setValue: (value) => {
        isChecked = Boolean(value);
        track.setAttribute('aria-checked', String(isChecked));
      },
      setDisabled: (disabled) => {
        track.disabled = disabled;
      }
    });
    const toggle = () => {
      if (track.disabled) return;
      control.setValue(!isChecked);
      control.notifyChange();
    };
    track.addEventListener('click', toggle);
    label.addEventListener('click', () => {
      toggle();
      track.focus();
    });
    control.setDisabled(Boolean(settings.disabled));
    control.setValue(settings.checked);
    return control;
  };
})();
