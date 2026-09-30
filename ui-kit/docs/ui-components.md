# 界面组件库说明书

本文说明 AI Video Studio（智影）页面内界面组件库的结构、用法和扩展方法。所有 Webview 页面（编辑器区页面和侧栏）都必须使用这套组件，**不使用 VS Code 内置的确认框、输入框和消息弹窗，也不使用浏览器原生的表单控件外观**。页面与表单如何使用这些组件，见 [page-form-design.md](../../doc/page-form-design.md)。

## 1. 设计目标与原则

| 原则 | 说明 |
|---|---|
| 统一入口 | 全部能力挂在全局对象 `aiUi` 上，调用写法一致、简单 |
| 统一控件接口 | 所有控件返回同一种控件对象，读写值、校验标记、订阅变化的方式相同 |
| 自绘 | 单行与多行输入、下拉列表、单选、复选、开关都是自绘外观，下拉弹层和对话框也是页内自绘 |
| 主题自适应 | 颜色全部来自令牌变量，随 VS Code 亮暗主题切换，不写单主题硬编码 |
| 可访问 | 按 ARIA 语义实现，支持键盘操作，焦点可见，状态不只靠颜色表达 |
| 不引入依赖 | 原生 JavaScript 和 CSS，不使用第三方库和构建工具 |

## 2. 文件结构

```
ui-kit/                        组件库（自绘控件、对话框及其文档、测试都集中在这里，唯一源码）
  manifest.json                文件清单：样式与脚本的加载顺序（供测试使用，与 page-resources.ts 一致）
  docs/ui-components.md        本说明书
  src/
    ui-tokens.css              设计令牌：颜色、状态色、控件与对话框变量（亮暗主题）
    ui-controls.css            按钮、输入、下拉、单选、复选、开关、字段包装的样式（含各控件的禁用外观）
    ui-dialog.css              对话框、遮罩、标题栏、调整大小把手、删除确认提示的样式
    ui-scrollbar.css           自绘滚动条：无箭头、无背景、悬停才显示滑块
    ui-core.js                 命名空间 aiUi、元素创建 h、唯一 id、事件发射器、层容器、指针跟踪、控件基类
    ui-scrollbar.js            悬停标记（data-ui-hover），配合 ui-scrollbar.css 显示滚动条
    ui-button.js               按钮（含添加、修改、删除预设）
    ui-input-controls.js       单行输入框、多行文本框
    ui-select.js               下拉列表
    ui-choice-controls.js      单选组、复选框、复选框组、开关
    ui-field.js                字段包装：标签、说明、错误提示
    ui-dialog.js               对话框：确认、提示、删除确认、弹出页面
  test/
    load-manifest.mjs          读取 manifest.json，给出 src 目录路径
    ui-environment.mjs         DOM 测试环境（jsdom）：加载组件库脚本、模拟排版与事件
    manifest.test.mjs          清单与 src 一一对应、加载顺序、文件头
    ui-controls.test.mjs       控件测试（含可用与禁用两种状态）
    ui-dialog.test.mjs         对话框测试（确认、删除确认、拖动、调整大小）
    ui-styles.test.mjs         样式静态检查（滚动条、禁用态令牌）
```

各文件职责单一：控件按类别分文件，对话框独立成文件，令牌与样式分开，便于按需修改。所有控件与对话框的代码、样式、文档和测试都在 `ui-kit/` 下，页面与扩展宿主的代码不在其中。

扩展直接从 `ui-kit/src` 加载组件库，没有复制或构建步骤：页面清单中的路径相对扩展根目录（如 `ui-kit/src/ui-core.js`、`resources/form/form.css`），`src/app/panels/webview-resources.ts` 把 `resources` 与 `ui-kit/src` 设为 Webview 可加载的目录并转换资源地址。打包扩展时 `ui-kit/src` 会被包含，`ui-kit/test`、`ui-kit/docs`、`ui-kit/manifest.json` 不会。

## 3. 接入页面

### 3.1 加载清单

各页面加载哪些样式和脚本，统一在 `src/app/panels/page-resources.ts` 中维护，不在页面代码里手写：

| 清单 | 用途 |
|---|---|
| `PROJECT_LIST_PAGE_RESOURCES` | 项目列表页（新建、编辑表单在页内弹出，因此一并加载表单引擎 `form/form-runtime.js`） |
| `SIDEBAR_PAGE_RESOURCES` | 侧栏页面（不加载 `theme.css`，避免影响自己的布局） |

编辑器区页面的加载顺序固定为：令牌样式、页面基础样式、控件与对话框样式、页面自己的样式；脚本为通信桥、组件库脚本、页面自己的脚本。这个顺序由 `createEditorPageResources` 保证。

### 3.2 新增一个页面的步骤

1. 在 `resources/<页面名>/` 下建页面自己的脚本和样式。
2. 在 `page-resources.ts` 中用 `createEditorPageResources(样式列表, 脚本列表)` 增加该页面的清单并导出。
3. 打开面板时把清单传给面板管理器：`styles: XXX_PAGE_RESOURCES.styles`、`scripts: XXX_PAGE_RESOURCES.scripts`。
4. 页面脚本直接使用 `aiUi`，页面根节点为 `#app`。

`npm test` 中的资源清单测试会检查：清单里的文件都存在、没有重复、加载顺序正确、`ui-kit` 下的每个文件都被页面使用。

### 3.3 新增一个组件库文件的步骤

1. 在 `ui-kit/src/` 下新建文件。
2. 把它加入 `ui-kit/manifest.json` 的 `styles` 或 `scripts`，以及 `page-resources.ts` 中的 `UI_LIBRARY_SCRIPTS` 或 `UI_COMPONENT_STYLES`，位置要在它依赖的文件之后（两处顺序不一致时测试会报错）。
3. 运行 `npm test`，确认清单测试和组件库测试都通过。

## 4. 通用约定

### 4.1 创建元素：`aiUi.h`

```js
aiUi.h('div', { class: 'card', text: '标题', attrs: { role: 'note' }, on: { click: handler } }, 子节点...)
```

| 选项 | 说明 |
|---|---|
| `class` | 类名 |
| `text` | 文本内容（自动转义，不会当作 HTML） |
| `hidden` | 为 true 时隐藏 |
| `attrs` | 属性对象，值为 `undefined` 或 `null` 时忽略 |
| `on` | 事件处理函数对象，键为事件名 |
| 子节点 | 节点或字符串，`null`、`undefined`、`false` 会被忽略，数组会被展开 |

页面代码不使用 `innerHTML` 拼接用户内容。

### 4.2 控件对象

所有控件（`textInput`、`textArea`、`select`、`radioGroup`、`checkbox`、`checkboxGroup`、`switchControl`）返回同样的对象：

| 成员 | 说明 |
|---|---|
| `element` | 根元素，挂到页面上 |
| `focusTarget` | 聚焦目标 |
| `ariaTarget` | 承载 `aria-*` 属性的元素 |
| `labelable` | 是否可用 `label for` 关联（输入框、多行文本框为 true） |
| `getValue()` | 读取当前值 |
| `setValue(value)` | 设置值（不触发变化通知） |
| `setDisabled(disabled)` | 禁用或启用；根元素会同步加减 `ui-is-disabled` 类，禁用外观见 5.9 |
| `isDisabled()` | 当前是否禁用 |
| `setInvalid(isInvalid)` | 标记校验失败（样式与 `aria-invalid`） |
| `focus()` | 聚焦 |
| `onChange(listener)` | 订阅用户改变的值，返回取消订阅的函数 |
| `notifyChange()` | 控件内部在用户改变值时调用；页面代码一般不需要 |

创建时也可以传入 `onChange` 选项，效果与 `onChange(listener)` 相同。`setValue` 不触发变化通知，避免程序设置值时形成循环。

### 4.3 值的类型

| 控件 | `getValue()` 返回 |
|---|---|
| `textInput`、`textArea` | 文本 |
| `select` | 所选值；未选为空串；选了“其他（手动输入）”时为输入的文本 |
| `radioGroup` | 所选值；未选为空串 |
| `checkbox`、`switchControl` | 布尔值 |
| `checkboxGroup` | 已选值数组，按选项顺序排列 |

### 4.4 选项格式

`options` 可以是字符串数组，也可以是 `{ value, label }` 数组；字符串选项的值与文字相同：

```js
['16:9', '9:16']
[{ value: 'single', label: '单个短视频' }, { value: 'series', label: '多集短片' }]
```

## 5. 控件

### 5.1 按钮 `aiUi.button`

```js
const saveButton = aiUi.button({ text: '保存', variant: 'primary', onClick: () => save() });
container.append(saveButton.element);
saveButton.setDisabled(true);
saveButton.setText('保存中…');

// “添加”“修改”“删除”预设：自带样式、默认文字和图标
aiUi.button({ kind: 'add', onClick: addItem });
aiUi.button({ kind: 'edit', compact: true, ariaLabel: `修改：${name}`, onClick: editItem });
aiUi.button({ kind: 'delete', iconOnly: true, onClick: removeItem });
aiUi.button({ kind: 'add', text: '创建项目' });   // 文字可覆盖
```

| 选项 | 说明 |
|---|---|
| `text` | 按钮文字；使用 `kind` 时可省略 |
| `kind` | 操作预设：`add` 添加（主要样式、“+”图标）、`edit` 修改（次要样式、铅笔图标）、`delete` 删除（危险样式、垃圾桶图标）；未知预设会报错 |
| `variant` | `primary` 主要、`secondary` 次要（默认）、`danger` 危险；可覆盖预设的样式 |
| `icon` | 图标名（`plus`、`pencil`、`trash`）；传 `false` 去掉预设的图标 |
| `iconOnly` | 只显示图标，文字作为可访问名称；需要有图标才生效 |
| `compact` | 紧凑尺寸，用于表格行内操作 |
| `type` | `button`（默认）或 `submit` |
| `ariaLabel` | 可访问名称，图标或同名按钮必须提供 |
| `disabled`、`onClick` | 禁用状态与点击处理 |

图标是内联 SVG，颜色跟随文字，禁用时一起变灰。返回 `{ element, setDisabled, isDisabled, setText, focus }`。

### 5.2 单行输入 `aiUi.textInput`

```js
const search = aiUi.textInput({ type: 'search', placeholder: '搜索项目名称', ariaLabel: '搜索项目名称', onChange: (text) => filter(text) });
```

选项：`id`、`value`、`placeholder`、`type`（`text`、`search`、`password`）、`ariaLabel`、`disabled`、`onChange`、`onEnter`（在输入框内按回车）。

### 5.3 多行文本 `aiUi.textArea`

选项：`id`、`value`、`placeholder`、`rows`、`ariaLabel`、`disabled`、`onChange`。右下角有自绘的拖动把手（一条短横线，鼠标悬停变深），只能纵向调整高度，最小高度 78px；不使用浏览器原生的 `resize` 手柄（样式中设为 `resize: none`）。拖动由 `aiUi.trackPointer` 实现，与对话框拖动、调整大小共用。

### 5.4 下拉列表 `aiUi.select`

```js
const ratio = aiUi.select({ options: ['16:9', '9:16', '1:1'], value: '16:9', onChange: (value) => apply(value) });
const style = aiUi.select({ options: STYLES, allowCustom: true });
```

| 选项 | 说明 |
|---|---|
| `options`、`value` | 选项与初始值 |
| `placeholder` | 未选时显示的文字，默认“请选择” |
| `allowEmpty` | 默认 true，列表最前提供“请选择”用于清空；必填字段传 false |
| `allowCustom` | 为 true 时列表末尾提供“其他（手动输入）”，选中后下方出现输入框，`getValue()` 返回输入的文本 |
| `customLabel`、`customPlaceholder` | 自定义项的文字与输入框占位文字 |
| `ariaLabel`、`disabled`、`onChange` | 同其他控件 |

行为：

- 选项弹层放在全页层容器中，不会被对话框、表格或滚动区域裁切；下方空间不足时自动翻到上方。
- 键盘：焦点在触发器上时，上下方向键、回车、空格打开；打开后上下方向键、Home、End 移动，回车或空格选择，Esc 只关闭弹层（不会关闭所在的对话框），Tab 关闭弹层并移走焦点。
- 窗口缩放或页面滚动时弹层自动关闭。

### 5.5 单选组 `aiUi.radioGroup`

```js
const kind = aiUi.radioGroup({ options: ['单个短视频', '多集短片'], value: '单个短视频', direction: 'horizontal' });
```

选项：`options`、`value`、`direction`（`vertical` 默认或 `horizontal`）、`ariaLabel`、`disabled`、`onChange`。键盘：Tab 进入所选项，方向键移动并选中，空格或回车选中。

### 5.6 复选框 `aiUi.checkbox`

```js
const follow = aiUi.checkbox({ label: '尾帧接首帧', checked: true, onChange: (checked) => update(checked) });
```

选项：`label`、`checked`、`id`、`ariaLabel`、`disabled`、`onChange`。点击或空格切换。

### 5.7 复选框组 `aiUi.checkboxGroup`

选项：`options`、`value`（已选值数组）、`direction`、`ariaLabel`、`disabled`、`onChange`。`getValue()` 返回按选项顺序排列的已选值数组。

### 5.8 开关 `aiUi.switchControl`

```js
const audio = aiUi.switchControl({ label: '生成声音', checked: true, onChange: (on) => update(on) });
```

选项：`label`、`checked`、`id`、`disabled`、`onChange`。使用 `role="switch"` 与 `aria-checked`；点击开关或左侧文字都可切换。

### 5.9 可用与禁用状态

所有控件都能以 `disabled: true` 创建，也能随时用 `setDisabled(true|false)` 切换。禁用外观统一使用 `--disabled-text`、`--disabled-bg`、`--disabled-border` 三个令牌，亮暗主题都能看清：

| 控件 | 禁用时 |
|---|---|
| 按钮（各样式、预设、纯图标） | 灰底灰字，去掉悬停与按下反馈，鼠标光标不变，点击不触发 |
| 单行输入、多行文本 | 灰底、淡边框、灰字，不可编辑和聚焦，多行文本的高度把手隐藏 |
| 下拉列表 | 灰底灰字，不能展开；展开时被禁用会立即收起弹层；“其他（手动输入）”的输入框同步禁用 |
| 单选、复选框、复选框组 | 标记灰底淡边框，文字变灰，选中标记保留但变为灰色；`aria-disabled="true"`，不可 Tab 到达，点击、空格、方向键都不改变选择 |
| 开关 | 轨道与滑块变灰（开启时为淡强调色），左侧文字变灰，点开关或文字都不切换 |

禁用时根元素带 `ui-is-disabled` 类，页面自己的样式也可以据此调整。

## 6. 字段包装 `aiUi.field`

给任意控件加上标签、说明和错误提示，并建立无障碍关联：

```js
const nameField = aiUi.field({ label: '项目名称', description: '项目的唯一名称，最多 50 字', required: true, control: aiUi.textInput() });
form.append(nameField.element);
nameField.setError('项目名称不能为空。');   // 显示错误，控件标红并带 aria-invalid
nameField.setError('');                     // 清除错误
```

| 选项 | 说明 |
|---|---|
| `label` | 字段标签；复选框和开关自带文字，不传 |
| `description` | 标签下方的说明文字 |
| `required` | 为 true 时说明文字以“必填，”开头；没有说明时显示“必填”。不用星号，也不只靠颜色 |
| `control` | 要包装的控件对象 |

有标签时顺序为“标签、说明、控件、错误”；没有标签时为“控件、说明、错误”。返回 `{ element, control, setError, getError }`。

## 7. 对话框

### 7.1 种类与用途

| 函数 | 用途 | 返回 |
|---|---|---|
| `aiUi.alert(options)` | 提示，只有“确定” | `Promise<void>` |
| `aiUi.confirm(options)` | 确认，“确定”与“取消” | `Promise<boolean>` |
| `aiUi.confirmDelete(options)` | 删除确认，红色提示要求输入名称 | `Promise<boolean>` |
| `aiUi.openPage(options)` | 弹出页面，可调整大小，内容自定义 | 对话框句柄 |
| `aiUi.openDialog(options)` | 底层入口，以上都基于它 | 对话框句柄 |

### 7.2 提示与确认

```js
await aiUi.alert({ title: '提示', message: '该功能尚未开放。' });

const shouldDiscard = await aiUi.confirm({
  title: '放弃修改',
  message: '放弃未保存的修改？',
  confirmText: '放弃修改',
  cancelText: '继续编辑',
  variant: 'danger'
});
if (shouldDiscard) closeForm();
```

`confirm` 的选项：`title`、`message`（字符串或字符串数组，每项一段）、`details`（明细列表）、`confirmText`、`cancelText`、`variant`（`primary` 或 `danger`）、`modal`（默认 true）。`variant` 为 `danger` 时“确定”按钮为红色，且初始焦点在“取消”上，避免回车误操作。用户点了确定返回 true；点取消、右上角 ×、按 Esc 都返回 false。

### 7.3 删除确认

```js
const confirmed = await aiUi.confirmDelete({
  title: '删除项目',
  message: '将删除项目“灯塔计划”及其下的全部内容，且无法恢复：',
  details: ['2 个作品', '14 个资产', '3 个视频结果'],
  confirmName: '灯塔计划',
  nameLabel: '项目名称'
});
```

| 选项 | 说明 |
|---|---|
| `confirmName` | 必填。需要用户输入的名称，区分大小写、完全一致（首尾空格也算不一致） |
| `nameLabel` | 名称的称呼，如“项目名称”，用于提示文字 |
| `message`、`details` | 说明与影响范围明细 |
| `title`、`deleteText`、`cancelText`、`modal` | 标题、按钮文字、是否模态 |

效果类似 GitHub 删除仓库：对话框里有一块红色背景的醒目提示，要求在下方输入框中输入名称；输入一致之前“删除”按钮一直是禁用的；初始焦点在输入框上。

> 前端确认只是体验层。宿主的删除请求必须再校验一次确认名称，见第 9 节。

### 7.4 弹出页面

```js
const page = aiUi.openPage({
  title: '选择资产',
  content: contentElement,
  width: 640, height: 420, minWidth: 360, minHeight: 240,
  buttons: [
    { id: 'ok', text: '确定', variant: 'primary', isDefault: true, onClick: () => save() },
    { id: 'cancel', text: '取消', isCancel: true }
  ]
});
const result = await page.closed;   // { reason, buttonId }
```

弹出页面可以拖动右边、下边和右下角三处调整大小；只向右、向下生长，左上角位置不变；有最小尺寸限制，也不会超出窗口。按住标题行可以拖动移位（见 7.8）。

**关闭前确认**：用 `beforeClose` 在用户点右上角 ×、按 Esc 或点“取消”时先询问，返回 `false`（或 resolve 为 `false`）则保持打开。表单用它在有未保存修改时确认是否放弃：

```js
const page = aiUi.openPage({
  title: '编辑',
  content: formElement,
  beforeClose: async ({ reason }) => !isDirty() || (await aiUi.confirm({ message: '放弃未保存的修改？', variant: 'danger' }))
});
```

普通按钮（如“保存”）和程序调用 `close()` 不经过 `beforeClose`；询问未结束时重复触发不会再次询问。

### 7.5 底层 `aiUi.openDialog` 选项

| 选项 | 说明 |
|---|---|
| `title` | 标题 |
| `content` | 内容，元素或文本 |
| `buttons` | 按钮数组，见下表 |
| `kind` | `dialog`（默认，固定大小，不可调整）或 `page` |
| `modal` | 是否模态，默认 true |
| `closable` | 是否允许右上角 × 与 Esc 关闭，默认 true |
| `role` | `dialog`（默认）或 `alertdialog` |
| `width`、`height` | 初始尺寸（像素）；对话框默认宽 420，弹出页面默认宽 640 |
| `minWidth`、`minHeight` | 调整大小的下限，默认 320、160 |
| `resizable` | 弹出页面是否可调整，默认 true |
| `draggable` | 是否可按住标题行拖动移位，默认 true |
| `initialFocus` | `default`、`cancel`、`first` 或某个元素；不指定时，对话框聚焦默认按钮，弹出页面聚焦内容里第一个可聚焦元素 |
| `onClose` | 关闭时的回调，参数为 `{ reason, buttonId }` |
| `beforeClose` | 用户经 ×、Esc 或取消按钮关闭前调用，参数为 `{ reason }`；返回 `false`（或 resolve 为 `false`）时保持打开 |

按钮描述：

| 字段 | 说明 |
|---|---|
| `id` | 标识，用于 `setButtonDisabled`、`getButton` 和关闭结果 |
| `text`、`variant` | 文字与样式 |
| `isDefault` | 默认按钮：在输入框中按回车时触发 |
| `isCancel` | 取消按钮：关闭原因记为 `cancel` |
| `disabled` | 初始是否禁用 |
| `onClick(handle)` | 点击时执行，可返回 Promise；返回 `false`（或 resolve 为 false）时对话框保持打开。执行期间所有按钮暂时禁用，防止重复点击 |

句柄：

| 成员 | 说明 |
|---|---|
| `element`、`bodyElement`、`footerElement` | 对话框、内容区、按钮区元素 |
| `closed` | 关闭时 resolve `{ reason, buttonId }`，`reason` 为 `button`、`cancel`、`close`、`escape` 或 `api` |
| `close(reason)` | 关闭对话框（程序关闭，不经 `beforeClose`） |
| `requestClose(reason)` | 先经 `beforeClose` 询问，允许后再关闭；×、Esc 和取消按钮内部用它，返回 Promise |
| `setTitle(text)` | 修改标题 |
| `setButtonDisabled(id, disabled)` | 禁用或启用某个按钮 |
| `getButton(id)` | 取得按钮对象 |

### 7.6 模态与非模态

| 项 | 模态（默认） | 非模态（`modal: false`） |
|---|---|---|
| 遮罩 | 有半透明遮罩 | 无 |
| 背后页面 | 不可点击、不可聚焦（`inert`） | 仍可正常操作 |
| Tab 焦点 | 在对话框内循环 | 不限制 |
| Esc | 关闭最上层的模态对话框 | 焦点在该窗口内时才关闭它 |
| 叠加 | 可以叠加，Esc 每次关闭最上层一个 | 多个窗口依次错开摆放，点击某个窗口把它提到最上层 |

关闭后焦点回到打开前的元素，页面恢复可操作。

### 7.7 键盘

| 按键 | 行为 |
|---|---|
| Esc | 关闭（`closable` 为 true 时）；焦点在下拉弹层内时只关闭弹层 |
| Tab、Shift+Tab | 模态对话框内循环 |
| 回车 | 焦点在输入框或对话框上时，触发默认按钮（按钮被禁用则无效）；焦点在多行文本框、按钮或下拉触发器上时不触发 |

### 7.8 外观

- 顶部为标题行，背景色随亮暗主题变化，下方一条分割线，再往下是内容和按钮区。
- 标题行最右是关闭按钮 ×：平时为红色 ×，鼠标悬停时整个按钮变为红色背景、× 变白，按下时红色更深。
- 按住**标题行**拖动，可以移动对话框或弹出页面（关闭按钮上按下不会拖动）；移动范围限制在窗口内，不会拖出可视区域；不需要拖动时可传 `draggable: false`。
- 对话框（确认、提示、删除）**不可调整大小**；只有弹出页面可以调整大小。窗口大小变化时，对话框会被推回可视区域内。
- 内容区超出时出现自绘滚动条（见 10.3）。
- 窄宽度（例如侧栏）下对话框宽度不超过窗口宽度减去边距。

## 8. 表单引擎

表单不需要手写界面：页面调用 `aiForm.open({ form, params })`，它向宿主请求一个表单描述（schema），在**当前页面内弹出一个弹出页面**用本组件库渲染控件，并处理校验、提交和取消。不再单独打开表单页面（编辑器标签页）。前端引擎在 `resources/form/form-runtime.js`。

### 8.1 字段描述

`src/app/forms/form-schema.ts`：

| 字段 | 说明 |
|---|---|
| `key` | 字段键，也是提交内容中的键 |
| `label`、`description` | 标签与说明；`required` 为 true 时说明前自动加“必填，” |
| `control` | `text`、`textarea`、`select`、`radio`、`checkbox`、`switch`、`checkboxes` |
| `required` | 是否必填 |
| `maxLength` | 最大长度，界面即时校验，宿主再次校验 |
| `options` | 选项，`select`、`radio`、`checkboxes` 使用 |
| `allowCustom` | 下拉是否提供“其他（手动输入）” |
| `placeholder` | 输入框占位示例 |
| `checkUnique` | 失去焦点时向宿主检查唯一性 |

### 8.2 值的编码

字段值一律以文本传输：

| 控件 | 文本形式 |
|---|---|
| `text`、`textarea`、`select`、`radio` | 原文本，未选为空串 |
| `checkbox`、`switch` | `true` 或 `false` |
| `checkboxes` | JSON 数组文本，如 `["旁白","音效"]` |

### 8.3 定义一个新表单

```ts
export function createXxxForm(service: XxxService): FormDefinition {
  return {
    schema: { title: '新建作品', submitLabel: '保存', fields: [ /* 字段描述 */ ] },
    initialValues: {},
    checkField: (key, value) => (key === 'name' && !service.isNameAvailable(value) ? '已存在同名作品。' : undefined),
    submit: (values) => { service.create(values); }   // 失败时抛出 ValidationError、ConflictError
  };
}

// 登记到表单目录（名称 → 工厂）：工厂接收页面传来的参数，如编辑时的 { id }
const catalog: FormCatalog = new Map([['work.create', () => createXxxForm(service)]]);
// 在页面的路由器上注册（每个需要弹出表单的页面注册一次）
registerFormHandlers(router, catalog);
```

页面端打开（页面需加载 `form/form.css` 与 `form/form-runtime.js`，已包含在项目列表页的清单中）：

```js
const saved = await aiForm.open({ form: 'work.create' });              // 新建
await aiForm.open({ form: 'project.edit', params: { id: project.id } }); // 编辑，参数由工厂校验
```

`aiForm.open` 在弹出页面关闭后 resolve：已保存为 `true`，否则 `false`；表单打开失败（如项目不存在）时在页内提示并返回 `false`。数据变化后页面刷新依靠服务层的变化事件，不需要表单回调。

引擎负责：字段失去焦点时校验、提交前校验全部字段并聚焦第一个错误、提交中禁用按钮并显示“保存中…”、失败时保留输入并显示错误、成功后关闭弹出页面。宿主抛出的 `ValidationError`、`ConflictError` 会按字段键显示在对应字段下方。

宿主与页面的请求（`src/app/forms/form-handlers.ts`）：每次打开创建一个会话，后续请求带会话标识 `formId`。

| 请求 | 作用 |
|---|---|
| `form.open { form, params }` | 按名称与参数创建会话，返回 `{ formId, schema, values }` |
| `form.checkField { formId, key, value }` | 字段服务端检查（如名称唯一），返回 `{ error? }` |
| `form.submit { formId, values }` | 提交；成功后会话失效，失败时会话保留以便修改后重新提交 |
| `form.close { formId }` | 弹出页面关闭后释放会话 |

### 8.4 取消与关闭

点“取消”、右上角 × 或按 Esc 时，如果表单相对初始状态有修改，先用页内确认对话框询问“放弃未保存的修改？”（通过弹出页面的 `beforeClose`，见 7.4），确认后才关闭；没有修改则直接关闭。表单不再是编辑器标签页，不存在“直接关闭标签页无法拦截”的问题。

## 9. 与宿主配合的删除确认协议

删除类操作用两个请求，前端对话框与宿主校验双重保护：

| 请求 | 作用 |
|---|---|
| `xxx.prepareDelete { id }` | 宿主返回名称和影响范围，页面据此显示删除确认对话框 |
| `xxx.delete { id, confirmName }` | 宿主核对 `confirmName` 与记录名称完全一致才删除，否则返回 `confirmName` 字段的校验错误 |

项目删除已按此实现，见 `src/app/pages/project-list-handlers.ts`。后续作品、资产等删除照此复用。

## 10. 主题与样式

### 10.1 令牌

所有颜色、状态色都定义在 `ui-tokens.css` 的 CSS 变量中，亮主题的覆盖写在 `body.vscode-light` 下。样式文件只引用变量，不写固定颜色。主要变量：

| 类别 | 变量 |
|---|---|
| 基础 | `--bg`、`--text`、`--text-muted`、`--focus-border`、`--divider` |
| 状态 | `--status-success`、`--status-warning`、`--status-error` |
| 输入 | `--input-bg`、`--input-border` |
| 选择 | `--choice-mark-border`、`--option-hover-bg`、`--option-selected-bg`、`--switch-off-bg`、`--switch-off-hover-bg` |
| 按钮 | `--button-secondary-*`、`--button-danger-*` |
| 禁用态 | `--disabled-text`、`--disabled-bg`、`--disabled-border`（所有控件共用） |
| 滚动条 | `--scrollbar-size`、`--scrollbar-thumb-bg`、`--scrollbar-thumb-hover-bg`、`--scrollbar-thumb-active-bg`（定义在 `ui-scrollbar.css`） |
| 对话框 | `--dialog-bg`、`--dialog-border`、`--dialog-divider`、`--dialog-titlebar-bg`、`--dialog-shadow`、`--dialog-overlay`、`--dialog-close-*`、`--danger-notice-*` |

### 10.2 约定

- 组件库的类名一律以 `ui-` 开头，不影响宿主页面（例如侧栏）自己的样式。
- 新增颜色时先在 `ui-tokens.css` 增加变量并同时给出亮暗两套值，颜色一律用 `rgb()` 或 `rgba()` 写法。
- 尺寸遵循表单与页面样式基线：输入框高 24px、按钮高 22px、字段标签 12px 加粗、开关轨道 36 × 20 等。

### 10.3 滚动条

页面内所有可滚动的元素（对话框内容、下拉弹层、多行文本、表格等）统一使用自绘滚动条，页面自己不需要额外处理：

- 没有上下（左右）三角箭头按钮，轨道和角落没有背景。
- 平时滑块是透明的；鼠标移到可滚动区域上才出现滑块，鼠标移到滑块上变深，按住时更深。
- 滑块为圆角细条（约 6px），颜色来自主题文字色，亮暗主题自动适配。
- 鼠标悬停在滚动条上时光标保持箭头，不会变成所属元素的文字或手形光标。

实现分两部分：`ui-scrollbar.css` 用 `::-webkit-scrollbar` 系列伪元素定义外观（VS Code Webview 基于 Chromium）；`ui-scrollbar.js` 把鼠标所在元素及其祖先标记为 `data-ui-hover`，样式据此显示滑块。不直接用 `:hover` 是因为实测 Chromium 不会因 `:hover` 变化刷新自定义滚动条的伪元素样式，而属性变化可以。

注意：VS Code 的 Webview 默认样式会在 `html` 上设置 `scrollbar-color`，它会被子元素继承，而 Chromium 只要遇到非 `auto` 的 `scrollbar-color` 或 `scrollbar-width` 就会忽略 `::-webkit-scrollbar` 样式（滚动条会变回带箭头的原生样式）。因此 `ui-scrollbar.css` 在所有元素上把 `scrollbar-color` 重置为 `auto`。页面或组件样式中不要再设置非 `auto` 的 `scrollbar-color`、`scrollbar-width`（测试会检查）。需要隐藏某个元素的滚动条时，在该元素上单独写 `::-webkit-scrollbar { display: none; }`。

## 11. 无障碍要点

| 项 | 做法 |
|---|---|
| 标签关联 | 输入类用 `label for`；下拉、单选组、复选框组用 `aria-labelledby` |
| 说明与错误 | 用 `aria-describedby` 关联说明和错误文字；错误区 `aria-live="polite"`；校验失败控件带 `aria-invalid` |
| 语义 | 下拉为 `combobox` 加 `listbox`，单选为 `radiogroup` 加 `radio`，复选为 `checkbox`，开关为 `switch`，对话框为 `dialog` 或 `alertdialog` |
| 焦点 | 焦点轮廓始终可见；模态对话框内循环并在关闭后恢复；背后页面 `inert` |
| 不只靠颜色 | 必填写“必填，”；错误有文字；预览等状态带文字标签 |
| 动效 | 开关动画在用户设置“减少动态效果”时关闭 |

## 12. 扩展组件库

新增一种控件的清单：

1. 在 `ui-kit/src/` 的合适文件中（或新文件）用 `aiUi.makeControl` 组装，返回统一的控件对象；根元素、聚焦目标、`aria` 目标、`labelable` 要设置正确。
2. 样式加到 `ui-controls.css`，类名以 `ui-` 开头，颜色只用令牌。
3. 支持键盘操作和 ARIA 语义。
4. 如果表单需要用到，在 `form-schema.ts` 的 `FormControl` 中增加类型，并在 `form-runtime.js` 的 `createControl` 中增加分支，同时约定值的文本编码。
5. 更新本文档的控件说明，运行 `npm test`。

新增一种对话框：在 `ui-dialog.js` 中基于 `aiUi.openDialog` 写一个函数并挂到 `aiUi`，不要复制对话框的基础逻辑。

## 13. 例外与限制

| 项 | 说明 |
|---|---|
| 扩展激活失败 | 数据库无法打开时没有任何页面可用，只能用 VS Code 的错误提示告知用户，这是唯一保留的内置弹窗 |
| 弹出页面的键盘调整 | 目前只支持鼠标拖动调整大小 |
| 拖动与多显示器 | 对话框在 Webview 窗口范围内移动，不能拖到 VS Code 编辑器区之外 |
| 滚动条样式 | 依赖 Chromium 的 `::-webkit-scrollbar`，只适用于 VS Code Webview |
| 自动化测试 | DOM 测试用 jsdom，没有排版与绘制：位置尺寸按内联样式换算，只验证行为、属性和类名，不验证视觉外观（亮暗主题、滚动条、悬停效果需手工验证） |

## 14. 测试与验证

### 14.1 自动化测试

`npm test`（根目录）先编译，再一次运行 `out` 下的扩展测试和 `ui-kit/test/` 下的组件库测试。组件库测试使用开发依赖 `jsdom`：

| 文件 | 覆盖 |
|---|---|
| `ui-environment.mjs` | 测试环境：建立 jsdom 页面，按 `manifest.json` 的顺序加载 `src` 下的脚本；提供 `fire`、`pressKey`、`typeText`、`drag` 等模拟操作 |
| `manifest.test.mjs` | 清单与 `src` 目录一一对应、没有重复、脚本只依赖排在它前面的脚本、源文件都有文件头 |
| `ui-controls.test.mjs` | 各控件的读写值、变化通知、键盘操作，按钮预设，字段包装，滚动条悬停标记；“所有控件可用与禁用切换”的统一用例，新增控件时把它加入 `controlFactories` |
| `ui-dialog.test.mjs` | 对话框结构与 ARIA、模态与非模态、确认、提示、删除确认的名称校验、标题行拖动及边界、弹出页面调整大小、焦点恢复 |
| `ui-styles.test.mjs` | 样式文本的静态检查：滚动条无箭头无背景、悬停才显示、不使用标准滚动条属性；各控件的禁用样式使用禁用令牌 |

新增或修改组件时同步补充这些测试。编写用例时注意：jsdom 没有排版，不要断言真实像素位置；位置与尺寸由测试环境按元素内联样式换算，未设置高度时按 100 像素计算，视口为 1024 × 768。

### 14.2 手工验证清单

修改组件库后，至少验证：

1. 亮暗两个主题下，控件、对话框、关闭按钮的悬停与按下效果。
2. 下拉列表：鼠标选择、键盘选择、Esc 只关弹层、“其他（手动输入）”、下方空间不足时翻到上方。
3. 单选、复选框组、开关：点击与键盘操作，`aria-checked` 与值一致。
4. 对话框：模态遮罩与背后页面不可操作、Tab 循环、Esc 与回车、关闭后焦点恢复、多层叠加。
5. 删除确认：名称不一致或多了空格时按钮保持禁用，一致才可删除。
6. 弹出页面：三个方向调整大小、最小尺寸限制、页内下拉弹层显示在页面之上。
7. 侧栏窄宽度下的提示对话框。
8. 拖动对话框和弹出页面的标题行能移动，不会拖出窗口，在关闭按钮上按下不拖动。
9. 亮暗主题下所有控件和按钮的可用、禁用两种外观，尤其是单选、复选、开关的选中与未选中。
10. 滚动条：平时不显示，鼠标移到可滚动区域上才出现，没有箭头和轨道背景。屏幕截图工具可能不会捕捉到悬停状态的滑块，需要用真实鼠标验证。

## 15. 速查

```js
// 控件
const ctl = aiUi.textInput({ placeholder: '…' });          // 单行
const box = aiUi.textArea({ rows: 4 });                    // 多行
const sel = aiUi.select({ options: [...], allowCustom: true });
const rad = aiUi.radioGroup({ options: [...], value: 'a' });
const chk = aiUi.checkbox({ label: '…', checked: true });
const grp = aiUi.checkboxGroup({ options: [...], value: ['a'] });
const sw  = aiUi.switchControl({ label: '…' });
const btn = aiUi.button({ text: '保存', variant: 'primary', onClick });
const add = aiUi.button({ kind: 'add' });                // 添加 / 修改(edit) / 删除(delete)，带图标

// 字段
const f = aiUi.field({ label, description, required: true, control: ctl });  // f.setError('…')

// 对话框
await aiUi.alert({ message });
if (await aiUi.confirm({ message, variant: 'danger' })) { … }
if (await aiUi.confirmDelete({ message, confirmName, nameLabel })) { … }
const page = aiUi.openPage({ title, content, width, height, modal: false });
```
