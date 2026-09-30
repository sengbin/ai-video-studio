// ------------------------------------------------------------------------
// 名称：ui-button.js
// 说明：界面组件库的按钮：主要、次要、危险三种样式，以及带图标的“添加”“修改”“删除”预设。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：依赖 ui-core.js；图标为内联 SVG，颜色跟随文字；用法见 doc/ui-components.md。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const aiUi = window.aiUi;

  const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

  /** 操作预设：样式、默认文字和图标。 */
  const KINDS = {
    add: { variant: 'primary', text: '添加', icon: 'plus' },
    edit: { variant: 'secondary', text: '修改', icon: 'pencil' },
    delete: { variant: 'danger', text: '删除', icon: 'trash' }
  };

  /** 图标的线条路径，16×16 画布。 */
  const ICON_PATHS = {
    plus: 'M8 3v10M3 8h10',
    pencil: 'M3 13l.7-3.2 7.1-7.1a1.2 1.2 0 011.7 0l.8.8a1.2 1.2 0 010 1.7L6.2 12.3 3 13zM9.8 3.9l2.3 2.3',
    trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5M7 7v3.5M9 7v3.5'
  };

  /** 创建图标元素；名称不在 ICON_PATHS 中时返回 null。 */
  function createIcon(name) {
    const path = ICON_PATHS[name];
    if (!path) return null;
    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('class', 'ui-button__icon');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const shape = document.createElementNS(SVG_NAMESPACE, 'path');
    shape.setAttribute('d', path);
    svg.append(shape);
    return svg;
  }

  /**
   * 创建按钮。
   * @param {{ text?: string, kind?: 'add'|'edit'|'delete', variant?: 'primary'|'secondary'|'danger', icon?: string|false,
   *   iconOnly?: boolean, compact?: boolean, type?: 'button'|'submit', ariaLabel?: string, disabled?: boolean,
   *   onClick?: (event: MouseEvent) => void }} options 选项：
   *   kind 使用“添加/修改/删除”预设（样式、默认文字、图标），text 与 variant 可覆盖；
   *   icon 指定图标名（plus、pencil、trash）或 false 去掉预设图标；iconOnly 只显示图标，文字作为可访问名称；
   *   variant 默认 secondary。
   * @returns {{ element: HTMLButtonElement, setDisabled: (disabled: boolean) => void, isDisabled: () => boolean,
   *   setText: (text: string) => void, focus: () => void }}
   */
  aiUi.button = function (options) {
    const settings = options || {};
    const kind = settings.kind ? KINDS[settings.kind] : null;
    if (settings.kind && !kind) throw new Error(`未知的按钮预设：${settings.kind}`);

    const variant = settings.variant || (kind ? kind.variant : 'secondary');
    const text = settings.text !== undefined ? settings.text : kind ? kind.text : '';
    const iconName = settings.icon === false ? null : settings.icon || (kind ? kind.icon : null);
    const icon = iconName ? createIcon(iconName) : null;
    const iconOnly = Boolean(settings.iconOnly && icon);

    const classNames = ['ui-button', `ui-button--${variant}`];
    if (settings.kind) classNames.push(`ui-button--${settings.kind}`);
    if (settings.compact) classNames.push('ui-button--compact');
    if (iconOnly) classNames.push('ui-button--icon-only');

    const textElement = aiUi.h('span', { text });
    const element = aiUi.h(
      'button',
      {
        class: classNames.join(' '),
        attrs: { type: settings.type || 'button', 'aria-label': settings.ariaLabel || (iconOnly ? text : undefined) }
      },
      icon,
      iconOnly ? null : textElement
    );
    element.disabled = Boolean(settings.disabled);
    if (settings.onClick) element.addEventListener('click', settings.onClick);

    return {
      element,
      setDisabled(disabled) {
        element.disabled = disabled;
      },
      isDisabled: () => element.disabled,
      setText(value) {
        textElement.textContent = value;
        if (iconOnly) element.setAttribute('aria-label', value);
      },
      focus() {
        element.focus();
      }
    };
  };
})();
