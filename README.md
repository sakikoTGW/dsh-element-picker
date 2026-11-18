# dsh-element-picker

在 DSH 里"指哪引哪"：右侧面板顶栏一个图标，点一下进入选取，鼠标划过哪个元素就框出哪个，
点一下把它变成输入框里的**原生引用 chip**。⌥ 点取元素上的链接，⇧ 点取它携带的文件路径。

选中的内容不是一段死文本：它在输入框里是 DSH 自己的引用 chip，提交时序列化成模型能读的
结构，点击 chip 还能指回原来的元素。

## 安装

```bash
dsh plugin --profile desktop add dsh-element-picker
```

装完重载 DSH 窗口（或重启桌面端）。

## 用法

1. 右侧面板顶栏的**选取图标**（或窗口聚焦时按 `Ctrl+Alt+P`）
2. 鼠标划过界面元素 → 蓝色框跟随，提示条显示元素名
3. 点击 → 输入框出现引用 chip
4. `Esc` 退出

| 操作 | 引用的是 |
|---|---|
| 普通点击 | 元素本身 |
| `⌥` 点击 | 元素上的**链接** |
| `⇧` 点击 | 元素携带的**文件路径**（走 DSH 原生 `@path` 引用） |
| 点已有 chip | 回到该元素（滚动 + 闪烁定位） |

## 引用里有什么

```
[引用元素] button.el-button--primary · 保存
选择器: div.toolbar > button.el-button--primary
资源: https://…/icon.png
页面: dsh-app://app/
文本: 保存
```

- **选择器**：最短且唯一，跳过构建哈希类名（`FYC9oG_` 这类每版都变），并附带备用定位器
  （完整结构路径）；点击 chip 时逐个尝试
- **资源**：图片 `src`、链接 `href` —— 元素真正的身份
- **文件**：直接生成 DSH 官方文件引用（`source: reference`），图标、点击预览、提交格式与官方一致

## 覆盖范围

| 区域 | 支持 |
|---|---|
| DSH 自身界面（含右侧面板） | ✅ |
| 同源 iframe | ✅ 逐层 `>>>` 进入 |
| 侧栏浏览器（Electron `<webview>`，跨源网页） | ✅ 通过注入的页面 agent 选取 |
| 其他应用窗口 | ⚠️ 需 `config.external: true`，且受系统无障碍能力限制（见下） |

## 已知限制

- **跨源 iframe 但非 webview**（例如侧栏的 HTML 预览，未开 `allow-same-origin`）：浏览器不暴露
  DOM，无法选取，会在提示里说明
- **外部窗口**（`external: true`）：原生程序能读到控件；Chromium/Electron 窗口默认只暴露整窗，
  需要浏览器以 `--remote-debugging-port=9222` 启动才能读到内部元素
- 元素定位依赖 DOM 结构；DSH 大改版后哈希类名会变，此时备用定位器与内容定位仍然可用

## 协议扩展

选取与投递都是可编排的，见 [PROTOCOL.md](./PROTOCOL.md)：内置 `browser-cdp` / `desktop-wallpaper` /
`uia` 三个 provider 与 `composer` / `clipboard` 两个 output，用户可在
`$DSH_HOME/element-picker/{providers,outputs}/*.mjs` 里自己加，改完 `POST /element-picker/os/protocols/reload` 生效。

## 开发

```bash
node --check client.js          # 语法
node scripts/check-pack.mjs     # 打包体检（files 存在、无 BOM、文档齐全）
node scripts/e2e.mjs            # 对运行中的 DSH 跑协议/队列断言
```

## 许可

MIT

## 自己的浏览器里选（伴随扩展）

DSH 无法给一个**已经在跑**的浏览器开调试端口，所以外部浏览器改用一个小扩展做桥：

1. 右键侧栏的选取图标 →「浏览器扩展…」（会把扩展目录复制到剪贴板并提示状态）
2. `edge://extensions` → 打开「开发人员模式」→「加载解压缩的扩展」→ 选那个目录
3. 之后：在 DSH 里点图标开始选取 → 切到浏览器 → 悬停出现蓝框 → 点一下，引用进输入框

- 扩展只在**选取会话期间**把内核注入当前标签页，结束即撤离；不常驻、不抓页面内容
- 桥是回环 HTTP（默认端口 45917），每个会话一个一次性 token，取完即失效
- 配置：`extension: true`（总开关）、`extensionPort: 45917`

## 插入：一条链，四个通道

DSH 的输入框 API 会随版本变化，选取结果按下面顺序落位，绝不静默丢失：

| 顺序 | 机制 | 说明 |
|---|---|---|
| 1 | DSH 原生引用卡 `inputActions.insertQuote()` | `referenceStyle: quote` 时优先 |
| 2 | 引用 chip | 默认形态，可点击回指元素 |
| 3 | 纯文本引用块 | 没有 chip 能力时，toast 说明"已以纯文本插入" |
| 4 | 剪贴板 | 以上都不可用时复制并提示粘贴 |

提示只走 toast，不会写进输入框（不占 token）。

## 引用里有什么（六层）

| 层 | 字段 | 例子 |
|---|---|---|
| 身份 | 元素名 + 角色 | `保存 (button)` |
| 状态 | 展开/按下/勾选/禁用 | `状态: 收起` |
| 位置 | 祖先区域链 | `位置: 设置面板 > 音频 > 输出设备` |
| 画面 | 设备像素坐标 + 尺寸 + 视口 | `画面: 120,340 · 96×32 · 视口 2560×1600` |
| 序号 | 同角色第几个 + 表格行列 | `序号: #2/5 · 第3行第2列` |
| 内容 | 附近同类元素 | `附近: 取消 / 继续` |
| 重找 | 唯一性选择器 + 备用定位器 | `选择器: form#cart > button.btn-primary` |

详细度可配：`textDetail: compact / standard / full`（字符预算 120 / 240 / 480）。

## 贡献者

- **sakikoTGW** — 维护者：拾取内核、协议扩展层、CDP、引用芯片管线
- **Knot-chord** — [PR #1](https://github.com/sakikoTGW/dsh-element-picker/pull/1)：四通道统一拾取、伴随扩展桥接、四段插入降级、六层元素描述模型；这些思路已在本仓库重写落地（见 [CONTRIBUTORS.md](./CONTRIBUTORS.md)）