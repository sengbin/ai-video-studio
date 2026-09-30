// ------------------------------------------------------------------------
// 名称：ui-core.js
// 说明：界面组件库的基础：全局命名空间 aiUi、元素创建、唯一 id、事件发射器、层容器和控件基类。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：必须最先于其他 ui-*.js 加载；用法见 doc/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi || (window.aiUi = {});
  const LAYER_CLASS = 'ui-layer';

  let idCounter = 0;
  let layerElement = null;

  /**
   * 生成页面内唯一的元素 id。
   * @param {string} prefix id 前缀。
   * @returns {string}
   */
  aiUi.uid = function (prefix) {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
  };

  /** 把子节点追加到父元素，跳过空值并展开数组；字符串按文本追加。 */
  function appendChildren(parent, children) {
    for (const child of children) {
      if (child === null || child === undefined || child === false) continue;
      if (Array.isArray(child)) appendChildren(parent, child);
      else parent.append(child);
    }
  }

  /**
   * 创建元素。
   * @param {string} tag 标签名。
   * @param {{ class?: string, text?: string, hidden?: boolean, attrs?: Record<string, any>, on?: Record<string, Function> }} [props]
   *   class 类名；text 文本内容；hidden 是否隐藏；attrs 属性（值为 undefined 或 null 时忽略）；on 事件处理函数。
   * @param {...(Node|string|null|undefined|false|Array)} children 子节点。
   * @returns {HTMLElement}
   */
  aiUi.h = function (tag, props, ...children) {
    const element = document.createElement(tag);
    const options = props || {};
    if (options.class) element.className = options.class;
    if (options.text !== undefined) element.textContent = options.text;
    if (options.hidden) element.hidden = true;
    for (const [name, value] of Object.entries(options.attrs || {})) {
      if (value !== undefined && value !== null) element.setAttribute(name, String(value));
    }
    for (const [name, handler] of Object.entries(options.on || {})) element.addEventListener(name, handler);
    appendChildren(element, children);
    return element;
  };

  /**
   * 创建事件发射器。
   * @returns {{ on: (listener: Function) => () => void, emit: (value: any) => void }}
   */
  aiUi.emitter = function () {
    const listeners = new Set();
    return {
      on(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit(value) {
        for (const listener of [...listeners]) listener(value);
      }
    };
  };

  /**
   * 把选项规范化为 { value, label } 数组；字符串选项的值与文字相同。
   * @param {Array<string|{ value: string, label?: string }>} options 选项。
   * @returns {Array<{ value: string, label: string }>}
   */
  aiUi.normalizeOptions = function (options) {
    return options.map((option) =>
      typeof option === 'string'
        ? { value: option, label: option }
        : { value: option.value, label: option.label === undefined ? option.value : option.label }
    );
  };

  /**
   * 取得全页唯一的层容器：对话框与下拉弹层都放在其中，不受页面布局裁切。
   * @returns {HTMLElement}
   */
  aiUi.layer = function () {
    if (layerElement === null || !layerElement.isConnected) {
      layerElement = aiUi.h('div', { class: LAYER_CLASS });
      document.body.append(layerElement);
    }
    return layerElement;
  };

  /**
   * 从指针按下起跟踪移动，直到松开或取消；用于拖动对话框、调整对话框与多行文本框的大小。
   * @param {HTMLElement} target 接收指针事件的元素（会捕获指针，移出元素后仍能收到事件）。
   * @param {PointerEvent} downEvent 按下事件。
   * @param {(deltaX: number, deltaY: number) => void} onMove 移动时回调，参数为相对按下点的位移。
   * @param {() => void} [onEnd] 结束时回调。
   */
  aiUi.trackPointer = function (target, downEvent, onMove, onEnd) {
    downEvent.preventDefault();
    if (target.setPointerCapture) target.setPointerCapture(downEvent.pointerId);
    const handleMove = (event) => onMove(event.clientX - downEvent.clientX, event.clientY - downEvent.clientY);
    const finish = () => {
      target.removeEventListener('pointermove', handleMove);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      if (onEnd) onEnd();
    };
    target.addEventListener('pointermove', handleMove);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  };

  /**
   * 组装统一的控件对象。所有控件（文本、下拉、单选等）都返回同样的接口：
   * element 挂载用的根元素；focusTarget 聚焦目标；ariaTarget 承载 aria 属性的元素；labelable 是否可用 label for 关联；
   * getValue/setValue 读写值；setDisabled/isDisabled 禁用与查询；setInvalid 标记校验失败；focus 聚焦；onChange 订阅变化。
   * setDisabled 会给根元素统一加减 ui-is-disabled 类，各控件的禁用外观由样式按该类呈现。
   * @param {object} parts 控件各部分：element、focusTarget、ariaTarget、labelable、getValue、setValue、setDisabled、onChange。
   * @returns {object} 控件对象；notifyChange() 供控件内部在用户改变值时调用。
   */
  aiUi.makeControl = function (parts) {
    const emitter = aiUi.emitter();
    let disabled = false;
    const control = {
      element: parts.element,
      focusTarget: parts.focusTarget,
      ariaTarget: parts.ariaTarget || parts.focusTarget,
      labelable: Boolean(parts.labelable),
      getValue: parts.getValue,
      setValue: parts.setValue,
      setDisabled(value) {
        disabled = Boolean(value);
        parts.element.classList.toggle('ui-is-disabled', disabled);
        parts.setDisabled(disabled);
      },
      isDisabled: () => disabled,
      focus() {
        control.focusTarget.focus();
      },
      setInvalid(isInvalid) {
        (parts.invalidTarget || parts.element).classList.toggle('ui-is-invalid', isInvalid);
        if (isInvalid) control.ariaTarget.setAttribute('aria-invalid', 'true');
        else control.ariaTarget.removeAttribute('aria-invalid');
      },
      onChange: emitter.on,
      notifyChange() {
        emitter.emit(control.getValue());
      }
    };
    if (parts.onChange) emitter.on(parts.onChange);
    return control;
  };
})();
