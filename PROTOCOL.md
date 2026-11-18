# 选取协议（providers / outputs）

插件不含"硬编码的取元素方式"。一次选取被拆成两段：

```
屏幕上下文 ──► provider 解析 ──► pick ──► output 投递 ──► 输入框 / 剪贴板 / 你的程序
```

两段都是有序注册表，**都可以由用户自己加**。

## 目录

```
$DSH_HOME/element-picker/
  providers/*.mjs     # 解析协议：这个坐标/窗口该读成什么
  outputs/*.mjs       # 投递协议：读出来送哪里
```

改完文件不需要重启：`POST /element-picker/os/protocols/reload`，或直接把插件开关切一下。

## Provider

```js
export default {
  id: 'my-provider',          // 唯一
  label: '我的协议',
  priority: 50,               // 越大越先尝试
  match(ctx) { return true }, // 便宜的前置判断
  async pick(ctx) {
    // 返回 pick，或 null（"不是我的，交给下一个"）
    return {
      kind: 'element',        // element | url | file
      label: '按钮 · 保存',
      text: '保存',            // 可选
      selector: '#save',      // 可选（网页/DOM）
      page: 'https://…',      // 可选
      resource: 'https://…',  // 可选（图片/链接地址）
      path: 'C:\\a\\b.png',   // 可选（文件类）
      window: 'notepad — 文档.txt',
      controlType: 'Button', automationId: 'saveBtn', className: 'Button',
      bounds: { x, y, w, h },
      meta: { 任意: '你想带的信息' },
    }
  },
}
```

`ctx`：

```js
{
  point: { x: 900, y: 600 },                       // 物理像素
  window: { class: 'Chrome_WidgetWin_1', title: '…', processId: 123, processName: 'msedge' },
  hotkey: 'Ctrl+Alt+P',
}
```

## Output

```js
export default {
  id: 'copy-markdown',
  label: '复制为 Markdown',
  priority: 20,
  accept(pick) { return pick.kind === 'element' },
  async deliver(pick) { /* 想送哪送哪：剪贴板、HTTP、写文件… */ },
}
```

内置 output：

| id | 行为 |
|---|---|
| `composer` | 插进 DSH 输入框，成为引用 chip（默认） |
| `clipboard` | 把引用文本写进剪贴板 |

## 配置

`dsh-element-picker` 的插件 config：

```yaml
config:
  hotkey: 'Ctrl+Alt+P'
  inputs: ['browser-cdp', 'uia']      # 只用这些 provider（省略=全部，按 priority）
  outputs: ['composer']               # 只用这些 output
```

## 内置 provider

| id | 什么时候用它 |
|---|---|
| `browser-cdp` | 窗口类名是 `Chrome_WidgetWin_*`（Edge/Chrome/Electron），且浏览器带 `--remote-debugging-port`。把这一选交给标签页，读回真实 DOM：`选择器 / 页面 / 文本` |
| `desktop-wallpaper` | 点在桌面（`Progman`/`WorkerW`/explorer 空标题）上。不把桌面当"元素"，而是读注册表里的壁纸文件路径，得到 `kind: 'file'` |
| `uia` | 其余情况：Windows UI Automation 读光标下的控件（原生程序能读到按钮/输入框/列表项） |

## 例子

`$DSH_HOME/element-picker/providers/wallpaper-engine.mjs.example`
`$DSH_HOME/element-picker/outputs/clipboard-markdown.mjs.example`

去掉 `.example` 后缀即生效。它们演示了两件用户常提的事：**不把桌面当元素而是读壁纸图片**、**选完不进 DSH 而是进剪贴板**。

## 给插件用：`ctx.elementPicker`（宿主内 API）

别的插件不用写文件，直接注册即可：

```js
export const inject = ['elementPicker']

export function apply(ctx) {
  const off = ctx.elementPicker.registerProvider({
    id: 'my-cdp-bridge',
    priority: 120,
    match: (context) => context.window?.class?.startsWith('Chrome_WidgetWin'),
    async pick(context) {
      // ctx.elementPicker.helpers 里已经有内置的 CDP 客户端和 PowerShell 运行器
      const outcome = await ctx.elementPicker.helpers.cdp.pickInBrowser({
        windowTitle: context.window.title,
      })
      if (!outcome.ok) return null
      return { kind: 'element', label: outcome.pick.label, selector: outcome.pick.selector, page: outcome.pick.page }
    },
  })
  ctx.effect(() => off, 'my-plugin: provider')
}
```

输出同理：`registerOutput({ id, priority, accept, deliver })`。

外部工具（进程、脚本、另一个应用）不用写插件，直接打 HTTP：

```bash
# 把一次选取塞进 DSH（会变成引用 chip）
curl -X POST http://127.0.0.1:<port>/element-picker/os/pick \
     -H 'content-type: application/json' \
     -d '{"kind":"element","label":"按钮 · 保存","selector":"#save","page":"https://…","text":"保存"}'

# 让插件替你解析一个坐标
curl -X POST http://127.0.0.1:<port>/element-picker/os/resolve \
     -H 'content-type: application/json' \
     -d '{"point":{"x":900,"y":600},"window":{"class":"Chrome_WidgetWin_1","title":"…"}}'
```

服务接口一览：

| 方法 | 作用 |
|---|---|
| `registerProvider(def)` | 注册解析协议，返回注销函数 |
| `registerOutput(def)` | 注册投递协议，返回注销函数 |
| `resolve(context)` | 手动跑一次解析+投递 |
| `pushPick(pick)` | 直接把结果送进选取队列（等价于 HTTP `/pick`） |
| `describe()` | 当前注册表 |
| `reload()` | 重扫用户目录 |
| `helpers` | `{ cdp: { pickInBrowser, findDebugPort }, runPowerShell, formatPick }` |

事件：每次有结果会发 `ctx.on('element-picker/pick', (pick) => …)`。

## 诊断

```
GET  /element-picker/os/protocols          # 当前注册了什么、有没有加载错误
POST /element-picker/os/protocols/reload   # 重新扫描用户目录
POST /element-picker/os/resolve            # {point, window} → 谁解析、谁投递
GET  /element-picker/os/cdp/status         # 浏览器调试端口是否可用
```
