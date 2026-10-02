// ------------------------------------------------------------------------
// 名称：server.js
// 说明：页面测试工具的服务器：在 Node 中加载编译后的扩展并激活，把侧栏和面板的 Webview 通过 HTTP 提供给浏览器，页面消息经真实的路由、服务和数据库处理。
// 作者：Lion
// 邮箱：chengbin@3578.cn
// 日期：2026-09-30
// 备注：用法：先 npm run compile，再 node tools/page-harness/server.js [端口]；打开 http://localhost:端口/ 。仅供开发时手工验证使用，不参与打包。
//       侧栏与每个面板各用一个子域名（如 panel-2.localhost）加载：浏览器对同一主机最多同时保持 6 个连接，而每个页面都有一条长连接的事件流，共用主机名时页面多了会卡住。
// ------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..', '..');
const port = Number(process.argv[2] ?? process.env.HARNESS_PORT ?? 5177);
const dataDirectory = process.env.HARNESS_DATA ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-video-studio-harness-'));

// 让扩展代码里的 require('vscode') 得到假模块。
const fakeVscode = require('./fake-vscode');
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === 'vscode' ? fakeVscode : originalLoad.call(this, request, parent, isMain);
};

const { state, createMemento, createSecretStorage } = fakeVscode.__harness;
state.port = port;
state.extensionRoot = extensionRoot;

// 视频生成接口用假实现：不访问网络，也不花费额度。
require('./fake-qianwen').installFakeQianwen();

/** 允许浏览器读取的目录，与扩展的 Webview 资源目录一致。 */
const SERVED_ROOTS = ['resources', 'ui-kit/src'];
const MIME_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

/** 深色与浅色主题下的 VS Code 变量，放在 :root 上。 */
const THEME_VARIABLES = {
  dark: {
    '--vscode-foreground': 'rgb(204, 204, 204)',
    '--vscode-descriptionForeground': 'rgb(157, 157, 157)',
    '--vscode-sideBar-background': 'rgb(24, 24, 24)',
    '--vscode-editor-background': 'rgb(31, 31, 31)',
    '--vscode-editorWidget-background': 'rgb(37, 37, 38)',
    '--vscode-input-background': 'rgb(49, 49, 49)',
    '--vscode-input-border': 'rgb(60, 60, 60)',
    '--vscode-button-background': 'rgb(0, 120, 212)',
    '--vscode-button-foreground': 'rgb(255, 255, 255)',
    '--vscode-button-hoverBackground': 'rgb(2, 108, 189)',
    '--vscode-focusBorder': 'rgb(0, 120, 212)',
    '--vscode-font-family': "'Segoe UI', sans-serif"
  },
  light: {
    '--vscode-foreground': 'rgb(59, 59, 59)',
    '--vscode-descriptionForeground': 'rgb(113, 113, 113)',
    '--vscode-sideBar-background': 'rgb(248, 248, 248)',
    '--vscode-editor-background': 'rgb(255, 255, 255)',
    '--vscode-editorWidget-background': 'rgb(248, 248, 248)',
    '--vscode-input-background': 'rgb(255, 255, 255)',
    '--vscode-input-border': 'rgb(206, 206, 206)',
    '--vscode-button-background': 'rgb(0, 95, 184)',
    '--vscode-button-foreground': 'rgb(255, 255, 255)',
    '--vscode-button-hoverBackground': 'rgb(2, 80, 153)',
    '--vscode-focusBorder': 'rgb(0, 95, 184)',
    '--vscode-font-family': "'Segoe UI', sans-serif"
  }
};

/** 页面里最先执行的脚本：模拟 acquireVsCodeApi，并通过服务器事件流接收宿主消息。 */
function createShim(webviewId, nonce, theme) {
  const variables = Object.entries(THEME_VARIABLES[theme])
    .map(([name, value]) => `${name}: ${value};`)
    .join(' ');
  return `<style>:root { ${variables} } body { font-family: var(--vscode-font-family); }</style>
<script nonce="${nonce}">
(function () {
  document.addEventListener('DOMContentLoaded', function () { document.body.classList.add('vscode-${theme}'); });
  var received = 0;
  var source = new EventSource('/events/${webviewId}');
  source.onmessage = function (event) {
    received += 1;
    window.dispatchEvent(new MessageEvent('message', { data: JSON.parse(event.data) }));
  };
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (message) {
        fetch('/host/${webviewId}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message) });
      },
      getState: function () { return undefined; },
      setState: function () {}
    };
  };
})();
</script>`;
}

/** 读取请求体。 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** 主页：模拟 VS Code 的布局，左侧为侧栏，右侧为编辑器区标签页。 */
function createShellHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面测试工具</title>
<style>
  html, body { height: 100%; margin: 0; background: #1f1f1f; color: #ccc; font-family: 'Segoe UI', sans-serif; font-size: 12px; }
  #layout { display: flex; height: 100%; }
  #sidebar { width: 300px; flex: none; border-right: 1px solid #333; }
  #sidebar iframe { width: 100%; height: 100%; border: 0; }
  #editor { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #tabs { display: flex; gap: 2px; background: #181818; border-bottom: 1px solid #333; min-height: 30px; align-items: flex-end; }
  .tab { padding: 6px 12px; cursor: pointer; background: #222; border: 1px solid #333; border-bottom: 0; }
  .tab.active { background: #1f1f1f; color: #fff; }
  #panels { flex: 1; position: relative; }
  #panels iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: none; }
  #panels iframe.active { display: block; }
  #tools { margin-left: auto; padding: 4px 8px; display: flex; gap: 8px; align-items: center; }
</style></head><body>
<div id="layout">
  <div id="sidebar"><iframe id="sidebar-frame" src="http://sidebar.localhost:${port}/view/sidebar?theme=THEME"></iframe></div>
  <div id="editor">
    <div id="tabs"><span id="tab-list" style="display:flex;gap:2px"></span>
      <span id="tools">语言模型：<select id="lm-mode"><option value="normal">正常</option><option value="slow">较慢</option><option value="fail">调用失败</option><option value="unavailable">无可用模型</option></select></span>
    </div>
    <div id="panels"></div>
  </div>
</div>
<script>
  var theme = new URLSearchParams(location.search).get('theme') || 'dark';
  var frameHost = function (id) { return 'http://' + id + '.localhost:${port}'; };
  document.getElementById('sidebar-frame').src = frameHost('sidebar') + '/view/sidebar?theme=' + theme;
  var known = {}; var active = null; var revealSeen = {};
  function activate(id) {
    active = id;
    document.querySelectorAll('#panels iframe').forEach(function (f) { f.classList.toggle('active', f.dataset.id === id); });
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.id === id); });
  }
  async function refresh() {
    var state = await (await fetch('/api/state')).json();
    var panels = state.webviews.filter(function (w) { return w.kind === 'panel'; });
    var ids = panels.map(function (w) { return w.id; });
    Object.keys(known).forEach(function (id) {
      if (ids.indexOf(id) < 0) {
        document.querySelector('.tab[data-id="' + id + '"]').remove();
        document.querySelector('#panels iframe[data-id="' + id + '"]').remove();
        delete known[id];
        if (active === id) activate(Object.keys(known)[0] || null);
      }
    });
    panels.forEach(function (w) {
      if (!known[w.id]) {
        known[w.id] = true;
        var tab = document.createElement('div'); tab.className = 'tab'; tab.dataset.id = w.id; tab.textContent = w.title;
        tab.onclick = function () { activate(w.id); };
        document.getElementById('tab-list').appendChild(tab);
        var frame = document.createElement('iframe'); frame.dataset.id = w.id; frame.src = frameHost(w.id) + '/view/' + w.id + '?theme=' + theme;
        document.getElementById('panels').appendChild(frame);
        activate(w.id);
      }
      var tabElement = document.querySelector('.tab[data-id="' + w.id + '"]');
      if (tabElement && tabElement.textContent !== w.title) tabElement.textContent = w.title;
      if (w.revealCount !== (revealSeen[w.id] || 0)) { revealSeen[w.id] = w.revealCount; activate(w.id); }
    });
    document.getElementById('lm-mode').value = state.lmMode;
  }
  document.getElementById('lm-mode').onchange = function (e) {
    fetch('/api/lm', { method: 'POST', body: JSON.stringify({ mode: e.target.value }) });
  };
  setInterval(refresh, 400); refresh();
</script></body></html>`;
}

const revealCounts = new Map();
fakeVscode.__harness.state.events.on('reveal', (id) => revealCounts.set(id, (revealCounts.get(id) ?? 0) + 1));

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://localhost:${port}`);
  try {
    if (url.pathname === '/') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(createShellHtml().replace('THEME', url.searchParams.get('theme') ?? 'dark'));
      return;
    }

    if (url.pathname === '/api/state') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          lmMode: state.lmMode,
          messages: state.messages,
          webviews: [...state.webviews.values()].map((webview) => ({
            id: webview.id,
            kind: webview.kind,
            title: webview.title,
            revealCount: revealCounts.get(webview.id) ?? 0
          }))
        })
      );
      return;
    }

    if (url.pathname === '/api/lm' && request.method === 'POST') {
      const body = JSON.parse(await readBody(request));
      state.lmMode = body.mode;
      response.end('{}');
      return;
    }

    const viewMatch = /^\/view\/([\w-]+)$/.exec(url.pathname);
    if (viewMatch) {
      const webview = state.webviews.get(viewMatch[1]);
      if (!webview) {
        response.statusCode = 404;
        response.end('没有这个页面');
        return;
      }
      const theme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark';
      const nonce = /nonce="([^"]+)"/.exec(webview.html)?.[1] ?? '';
      const html = webview.html
        .replace("default-src 'none';", `default-src 'none'; connect-src http://*.localhost:${port};`)
        .replace(/style-src ([^;]+);/, "style-src $1 'unsafe-inline';")
        .replace('<head>', `<head>\n${createShim(webview.id, nonce, theme)}`);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(html);
      return;
    }

    const hostMatch = /^\/host\/([\w-]+)$/.exec(url.pathname);
    if (hostMatch && request.method === 'POST') {
      const webview = state.webviews.get(hostMatch[1]);
      const message = JSON.parse(await readBody(request));
      response.statusCode = 204;
      response.end();
      if (webview) {
        void webview.receive(message).catch((error) => console.error('[处理页面消息失败]', error));
      }
      return;
    }

    const eventsMatch = /^\/events\/([\w-]+)$/.exec(url.pathname);
    if (eventsMatch) {
      const webview = state.webviews.get(eventsMatch[1]);
      if (!webview) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (message) => response.write(`data: ${JSON.stringify(message)}\n\n`);
      webview.outbox.forEach(send);
      const listener = (message) => send(message);
      state.events.on(`message:${webview.id}`, listener);
      request.on('close', () => state.events.off(`message:${webview.id}`, listener));
      return;
    }

    const extMatch = /^\/ext\/(.+)$/.exec(url.pathname);
    if (extMatch) {
      const relative = decodeURIComponent(extMatch[1]);
      const allowed = SERVED_ROOTS.some((root) => relative.startsWith(`${root}/`));
      const filePath = path.join(extensionRoot, relative);
      if (!allowed || relative.includes('..') || !fs.existsSync(filePath)) {
        response.statusCode = 404;
        response.end('找不到文件');
        return;
      }
      response.setHeader('content-type', MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream');
      response.setHeader('cache-control', 'no-store');
      response.end(fs.readFileSync(filePath));
      return;
    }

    response.statusCode = 404;
    response.end();
  } catch (error) {
    console.error('[服务器错误]', error);
    response.statusCode = 500;
    response.end(String(error));
  }
});

// 激活扩展：与 VS Code 传入的上下文保持同样的形状。
const extension = require(path.join(extensionRoot, 'out', 'extension.js'));
const context = {
  extensionUri: fakeVscode.Uri.file(extensionRoot),
  globalStorageUri: fakeVscode.Uri.file(path.join(dataDirectory, 'storage')),
  globalState: createMemento(),
  secrets: createSecretStorage(),
  subscriptions: []
};
Promise.resolve(extension.activate(context)).then(
  () => {
    server.listen(port, () => {
      console.log(`页面测试工具已启动：http://localhost:${port}/ （数据目录：${dataDirectory}）`);
    });
  },
  (error) => {
    console.error('扩展激活失败：', error);
    process.exit(1);
  }
);
