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
