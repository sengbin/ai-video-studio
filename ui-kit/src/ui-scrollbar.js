// ------------------------------------------------------------------------
// 名称：ui-scrollbar.js
// 说明：界面组件库的滚动条辅助：把鼠标所在元素及其祖先标记 data-ui-hover，供样式在悬停时显示滚动条滑块。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：Chromium 中 :hover 不会刷新自定义滚动条的伪元素样式，改由属性变化触发样式重算；样式见 ui-scrollbar.css。
// ------------------------------------------------------------------------

'use strict';

(function () {
  const HOVER_ATTRIBUTE = 'data-ui-hover';

  /** 当前带有悬停标记的元素（鼠标所在元素及其全部祖先，与 :hover 的范围一致）。 */
  let hoveredElements = new Set();

  /** 从元素起向上收集自身与全部祖先元素。 */
  function collectAncestors(element) {
    const chain = new Set();
    for (let node = element; node && node.nodeType === Node.ELEMENT_NODE; node = node.parentElement) chain.add(node);
    return chain;
  }

  /** 把悬停标记更新为 next：去掉不再悬停的，补上新悬停的。 */
  function markHovered(next) {
    for (const element of hoveredElements) {
      if (!next.has(element)) element.removeAttribute(HOVER_ATTRIBUTE);
    }
    for (const element of next) {
      if (!hoveredElements.has(element)) element.setAttribute(HOVER_ATTRIBUTE, '');
    }
    hoveredElements = next;
  }

  document.addEventListener('mouseover', (event) => markHovered(collectAncestors(event.target)), true);
  document.documentElement.addEventListener('mouseleave', () => markHovered(new Set()));
})();
