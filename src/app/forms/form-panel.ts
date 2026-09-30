// ------------------------------------------------------------------------
// 名称：form-panel.ts
// 说明：表单面板：为一个表单定义打开独立面板，并接入关闭与放弃确认。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：表单页面由 resources/form 下的表单引擎渲染；面板标签页被直接关闭时无法拦截确认。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { MessageRouter } from '../messaging/message-router';
import { OpenedPanel, PanelManager } from '../panels/panel-manager';
import { FormDefinition } from './form-definition';
import { registerFormHandlers } from './form-handlers';

/** 表单面板的视图类型。 */
const FORM_PANEL_VIEW_TYPE = 'aiVideoStudio.form';
/** 表单页面使用的样式与脚本，路径相对 resources 目录。 */
const FORM_PAGE_STYLES = ['shared/theme.css', 'shared/controls.css', 'form/form.css'] as const;
const FORM_PAGE_SCRIPTS = ['shared/host-bridge.js', 'form/form-runtime.js'] as const;

const DISCARD_PROMPT = '放弃未保存的修改？';
const DISCARD_ACTION = '放弃修改';

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
      confirmDiscard: async () => (await vscode.window.showWarningMessage(DISCARD_PROMPT, { modal: true }, DISCARD_ACTION)) === DISCARD_ACTION,
      onCancelled: () => opened?.close()
    });

    opened = this.panels.open({
      key,
      viewType: FORM_PANEL_VIEW_TYPE,
      title: definition.schema.title,
      styles: FORM_PAGE_STYLES,
      scripts: FORM_PAGE_SCRIPTS,
      router
    });
  }
}
