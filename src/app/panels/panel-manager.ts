// ------------------------------------------------------------------------
// 名称：panel-manager.ts
// 说明：编辑器区 Webview 面板管理：按键复用已打开的面板，装配页面资源与请求路由。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：同一键的面板只保留一个，重复打开时聚焦已有面板；资源目录见 webview-resources.ts。
// ------------------------------------------------------------------------

import * as vscode from 'vscode';
import { EventEnvelope } from '../messaging/envelope';
import { MessageRouter } from '../messaging/message-router';
import { createPageHtml } from './page-html';
import { getWebviewResourceRoots, toWebviewResourceUri } from './webview-resources';

/** 打开面板所需的选项。 */
export interface PanelOptions {
  /** 面板的唯一键，同一键重复打开时聚焦已有面板。 */
  readonly key: string;
  readonly viewType: string;
  readonly title: string;
  /** 样式文件，路径相对扩展根目录，使用 `/` 分隔。 */
  readonly styles: readonly string[];
  /** 脚本文件，路径相对扩展根目录，使用 `/` 分隔。 */
  readonly scripts: readonly string[];
  readonly router: MessageRouter;
}

/** 已打开的面板句柄。 */
export interface OpenedPanel {
  /** 向界面推送事件；面板已关闭时忽略。 */
  postEvent(name: string, payload?: unknown): void;
  /** 关闭面板。 */
  close(): void;
  /** 面板关闭时调用，用于释放订阅。 */
  onDidClose(listener: () => void): void;
}

/** 面板管理器。 */
export class PanelManager {
  private readonly openedPanels = new Map<string, { readonly panel: vscode.WebviewPanel; readonly handle: OpenedPanel }>();

  /**
   * @param extensionUri 扩展安装目录 URI，用于定位静态资源。
   */
  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * 聚焦已打开的面板。
   * @param key 面板键。
   * @returns 该键的面板是否已存在（存在则已聚焦）。
   */
  reveal(key: string): boolean {
    const opened = this.openedPanels.get(key);
    if (opened === undefined) {
      return false;
    }
    opened.panel.reveal(undefined, false);
    return true;
  }

  /**
   * 打开面板；同一键的面板已存在时聚焦并返回已有面板的句柄。
   * @param options 面板选项。
   */
  open(options: PanelOptions): OpenedPanel {
    const existing = this.openedPanels.get(options.key);
    if (existing !== undefined) {
      existing.panel.reveal(undefined, false);
      return existing.handle;
    }

    // 切换标签后需要保留页面内状态（如已弹出的表单里的输入），因此保留隐藏面板的上下文。
    const panel = vscode.window.createWebviewPanel(options.viewType, options.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: getWebviewResourceRoots(this.extensionUri)
    });
    const webview = panel.webview;
    const toUri = (relativePath: string): string => toWebviewResourceUri(webview, this.extensionUri, relativePath);
    webview.html = createPageHtml({
      title: options.title,
      cspSource: webview.cspSource,
      styleUris: options.styles.map(toUri),
      scriptUris: options.scripts.map(toUri)
    });

    webview.onDidReceiveMessage(async (message: unknown) => {
      const response = await options.router.handle(message);
      if (response === undefined) {
        return;
      }
      try {
        await webview.postMessage(response);
      } catch {
        // 处理过程中面板已关闭（如提交成功后自动关闭），无需回复。
      }
    });

    const closeListeners: Array<() => void> = [];
    const handle: OpenedPanel = {
      postEvent: (name, payload) => {
        const event: EventEnvelope = { type: 'event', name, payload };
        void webview.postMessage(event);
      },
      close: () => panel.dispose(),
      onDidClose: (listener) => {
        closeListeners.push(listener);
      }
    };
    panel.onDidDispose(() => {
      this.openedPanels.delete(options.key);
      closeListeners.forEach((listener) => listener());
    });

    this.openedPanels.set(options.key, { panel, handle });
    return handle;
  }
}
