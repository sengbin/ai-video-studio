// ------------------------------------------------------------------------
// 名称：fake-vscode.js
// 说明：页面测试工具用的假 vscode 模块：模拟 Webview 视图与面板、设置、全局状态、密钥存储和语言模型，让编译后的扩展代码可以脱离 VS Code 运行。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：仅供开发时手工验证页面使用，不参与打包；只实现扩展实际用到的接口。
// ------------------------------------------------------------------------

'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createResponder } = require('./lm-responder');

/** 工具运行时的共享状态，由 server.js 在加载扩展前设置。 */
const state = {
  port: 0,
  extensionRoot: '',
  /** 语言模型模式：normal 正常、unavailable 无可用模型、slow 每次响应延迟更久、fail 调用失败。 */
  lmMode: 'normal',
  lmDelayMs: 300,
  /** 所有 Webview（侧栏视图与面板），键为分配的标识。 */
  webviews: new Map(),
  events: new EventEmitter(),
  configuration: new Map(),
  nextPanelId: 1
};

/** 简化的 Uri：只保留文件路径。 */
class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  static joinPath(base, ...segments) {
    return new Uri(path.join(base.fsPath, ...segments));
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

/** 假 Webview：记录 HTML，接收页面消息，把宿主消息排入待发送队列。 */
class FakeWebview {
  constructor(id, kind, title) {
    this.id = id;
    this.kind = kind;
    this.title = title;
    this.html = '';
    this.options = {};
    this.messageListeners = [];
    this.outbox = [];
    this.disposed = false;
  }
  get cspSource() {
    return `http://localhost:${state.port}`;
  }
  asWebviewUri(uri) {
    const relative = path.relative(state.extensionRoot, uri.fsPath).split(path.sep).join('/');
    const url = `http://localhost:${state.port}/ext/${relative}`;
    return { toString: () => url };
  }
  onDidReceiveMessage(listener) {
    this.messageListeners.push(listener);
    return { dispose: () => {} };
  }
  async postMessage(message) {
    if (this.disposed) {
      return false;
    }
    this.outbox.push(message);
    state.events.emit(`message:${this.id}`, message);
    return true;
  }
  /** 页面发来消息时调用所有监听者，并等待它们完成。 */
  async receive(message) {
    await Promise.all(this.messageListeners.map((listener) => listener(message)));
  }
}

/** 注册 Webview 并通知服务器。 */
function registerWebview(kind, title) {
  const id = kind === 'sidebar' ? 'sidebar' : `panel-${state.nextPanelId++}`;
  const webview = new FakeWebview(id, kind, title);
  state.webviews.set(id, webview);
  state.events.emit('webviews-changed');
  return webview;
}

const window = {
  registerWebviewViewProvider(viewType, provider) {
    const webview = registerWebview('sidebar', viewType);
    const view = { webview, onDidChangeVisibility: () => ({ dispose: () => {} }) };
    provider.resolveWebviewView(view);
    return { dispose: () => {} };
  },
  createWebviewPanel(viewType, title) {
    const webview = registerWebview('panel', title);
    const disposeListeners = [];
    const panel = {
      webview,
      viewType,
      reveal: () => {
        state.events.emit('reveal', webview.id);
      },
      dispose: () => {
        if (webview.disposed) return;
        webview.disposed = true;
        state.webviews.delete(webview.id);
        state.events.emit('webviews-changed');
        disposeListeners.forEach((listener) => listener());
      },
      onDidDispose: (listener) => {
        disposeListeners.push(listener);
        return { dispose: () => {} };
      },
      set title(value) {
        webview.title = value;
      }
    };
    return panel;
  },
  showErrorMessage(message) {
    console.error('[showErrorMessage]', message);
    return Promise.resolve(undefined);
  },
  showInformationMessage(message) {
    console.log('[showInformationMessage]', message);
    return Promise.resolve(undefined);
  }
};

const workspace = {
  getConfiguration(section) {
    return {
      get: (key, fallback) => {
        const value = state.configuration.get(`${section}.${key}`);
        return value === undefined ? fallback : value;
      },
      update: async (key, value) => {
        state.configuration.set(`${section}.${key}`, value);
        return undefined;
      }
    };
  }
};

/** 假 Copilot 语言模型。 */
function createModel(family) {
  const respond = createResponder();
  return {
    vendor: 'copilot',
    family,
    id: `copilot-${family}`,
    version: '1',
    name: family,
    maxInputTokens: 128000,
    async countTokens(text) {
      return Math.ceil(String(text).length / 2);
    },
    async sendRequest(messages, options, token) {
      if (state.lmMode === 'fail') {
        throw Object.assign(new Error('模拟的调用失败'), { code: 'Unknown' });
      }
      const parts = messages.flatMap((message) => message.content);
      const text = parts
        .filter((part) => typeof part.value === 'string')
        .map((part) => part.value)
        .join('\n');
      const delay = state.lmMode === 'slow' ? state.lmDelayMs * 6 : state.lmDelayMs;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        token?.onCancellationRequested?.(() => {
          clearTimeout(timer);
          reject(Object.assign(new Error('Canceled'), { name: 'Canceled' }));
        });
      });
      const output = respond(text);
      const tool = options?.tools?.[0];
      return {
        stream: (async function* stream() {
          // 与真实 Copilot 一样，带输出工具时模型通过工具调用返回结果对象。
          if (tool) yield new LanguageModelToolCallPart('call-1', tool.name, JSON.parse(output));
          else yield new LanguageModelTextPart(output);
        })()
      };
    }
  };
}

const lm = {
  async selectChatModels(selector = {}) {
    if (state.lmMode === 'unavailable') return [];
    const families = ['gpt-4o', 'claude-sonnet'];
    return families.filter((family) => selector.family === undefined || selector.family === family).map(createModel);
  }
};

class CancellationTokenSource {
  constructor() {
    this.listeners = [];
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: (listener) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
      }
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this.listeners.forEach((listener) => listener());
  }
  dispose() {}
}

class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

class LanguageModelDataPart {
  static image(data, mimeType) {
    return Object.assign(new LanguageModelDataPart(), { data, mimeType });
  }
}

class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

const LanguageModelChatMessage = {
  User: (content) => ({ role: 'user', content: Array.isArray(content) ? content : [new LanguageModelTextPart(content)] })
};

/** 假的全局状态。 */
function createMemento() {
  const store = new Map();
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => {
      store.set(key, value);
    },
    keys: () => [...store.keys()]
  };
}

/** 假的密钥存储（SecretStorage）：只保存在内存中，工具重启后丢失。 */
function createSecretStorage() {
  const store = new Map();
  return {
    get: async (key) => store.get(key),
    store: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    }
  };
}

module.exports = {
  Uri,
  ViewColumn: { Active: -1 },
  ConfigurationTarget: { Global: 1 },
  window,
  workspace,
  lm,
  CancellationTokenSource,
  LanguageModelTextPart,
  LanguageModelDataPart,
  LanguageModelToolCallPart,
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelChatMessage,
  __harness: { state, createMemento, createSecretStorage }
};
