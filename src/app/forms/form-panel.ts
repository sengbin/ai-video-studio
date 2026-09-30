// ------------------------------------------------------------------------
// 名称：form-panel.ts
// 说明：表单面板：为一个表单定义打开独立面板，接入提交与取消后的关闭。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：页面由 resources/form 下的表单引擎渲染；未保存修改的确认在页面内完成，直接关闭标签页时无法拦截。
// ------------------------------------------------------------------------

import { MessageRouter } from '../messaging/message-router';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { FORM_PAGE_RESOURCES } from '../panels/page-resources';
import { FormDefinition } from './form-definition';
import { registerFormHandlers } from './form-handlers';

/** 表单面板的视图类型。 */
const FORM_PANEL_VIEW_TYPE = 'aiVideoStudio.form';

/** 打开表单面板的入口。 */
export class FormPanelOpener {
  constructor(private readonly panels: PanelManager) {}

  /**
   * 打开表单面板；同一键的表单已打开时聚焦已有面板。
   * @param key 面板键，编辑同一条记录应使用同一键。
   * @param definition 表单定义。
   * @param onSubmitted 提交成功后额外执行的动作，面板随后自动关闭。
   */
  open(key: string, definition: FormDefinition, onSubmitted?: () => void): void {
    if (this.panels.reveal(key)) {
      return;
    }

    const router = new MessageRouter();
    let opened: OpenedPanel | undefined;
    registerFormHandlers(router, definition, {
      onSubmitted: () => {
        onSubmitted?.();
        opened?.close();
      },
      onCancelled: () => opened?.close()
    });

    opened = this.panels.open({
      key,
      viewType: FORM_PANEL_VIEW_TYPE,
      title: definition.schema.title,
      styles: FORM_PAGE_RESOURCES.styles,
      scripts: FORM_PAGE_RESOURCES.scripts,
      router
    });
  }
}
