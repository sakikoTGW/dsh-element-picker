# Contributors

## sakikoTGW

维护者。拾取内核、协议扩展层（provider/output）、CDP 通道、引用芯片管线、发布与索引。

## Knot-chord

[PR #1](https://github.com/sakikoTGW/dsh-element-picker/pull/1)：提出并实现了四通道统一的拾取内核、伴随浏览器扩展桥接、四段插入降级链、六层元素描述模型。

这些思路已按本仓库自己的实现合入 0.11.0 / 0.11.1：

| 来源 | 本仓库落点 |
|---|---|
| 伴随扩展桥接 | `bridge.js` + `extension/`（宿主自带回环服务、一次性 token、页面内核只在选取期间注入） |
| 四段插入降级 | `client.js` 的 `deliver()`：引用卡 → chip → 纯文本 → 剪贴板 |
| 六层元素描述 | 引用字段 `状态 / 画面 / 序号 / 附近` + `textDetail` 字符预算 |

原 PR 未直接合并，原因只有两点：它删除了 `protocols.js` / `PROTOCOL.md` 的协议扩展层；同时带入了硬编码作者本机路径的维护脚本。其余设计不影响本次采纳。

## 参考与致谢

- DSH 的 composer 引用节点与 `inputActions` 接口，决定了芯片与插入链的形态
- 四通道划分与"元素描述分六层"的问题拆解来自上面的 PR
