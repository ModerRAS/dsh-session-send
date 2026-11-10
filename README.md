# dsh-session-send（会话直发）

向同一工作区的另一个会话即时发送文本消息。`session_send` 工具经
`ctx.sessionController.prompt()` 入目标会话 inbox 并唤醒它，鉴权复用
`tool-session-query` 的 exact-cwd 模型。

## 工具

`session_send(target_session_id, text, mode?)`

- `target_session_id`：目标会话，需与调用者 `cwd` 字符串精确相等；自己、子代理、归档会话一律拒绝。
- `text`：非空、≤8000 字符的纯文本（v1 不支持图片/文件 receipt，file receipt 不可跨会话复用）。
- `mode`：`queue`（默认，排后续 turn 并唤醒）或 `steer`（打断到下一步边界）。
- 成功：`{"accepted":true,"targetSessionId":"..."}`；失败：`{code,message}`，
  code 含 `invalid_text / invalid_target / unauthorized / target_archived /
  target_not_found / delivery_failed / subagent_session / internal_error`。

## 鉴权

1. 调用方须是顶层 agent（`delegationDepth>0` 拒绝，防传递扇出）。
2. 调用方必须有 `cwd`；目标必须经 `filterSessions([{id},{cwd}])` 命中（不存在与跨工作区不可区分）。
3. live 目标走 `ctx.agents` 快查，cold 目标走 query；`origin==='subagent'` 或
   `delegationDepth>0` 走 subagent 投递，拒绝。
4. 归档目标直接拒绝（prompt 本体不拦，但 archived gate 会让 turn 以 blocked 结束）。

## 安装后

桌面版替换已装包需要**重启 DSH** 才能加载新 JS（HMR 只对新 bundle 生效）。
重启后在设置→插件确认 `session-send` 为 active，或用 inspector 的 Tool
列表确认 `session_send` 存在。

## 验证

1. 新开两个同目录会话 A、B，记下 B 的 sessionId（侧栏右键或 list）。
2. 在 A 中：`session_search` 找到 B，再 `session_send(target_session_id=B, text="ping from A")`。
3. 预期：返回 `accepted:true`；B 立即收到一条 user 消息并唤醒执行。
4. 反例：发给自己 → `invalid_target`；跨目录 id → `unauthorized`；
   发给已归档会话 → `target_archived`。

## 文件

- `index.js`：Host 插件，无 `@deepseek-ai/*` 顶层 import（桌面版 peer 缺装会整条不激活），只用 `ctx` 服务 + `node:crypto`。
- `cordis.patch.yml` / `package.json`：bundle 声明。
- `locale/en.json`、`locale/zh.json`、`icon.svg`：展示元数据。

## 修复记录

- v1.0.1（2026-11-10）：修 `session-send … did not activate: JsonSchemaError`。
  原因：插件用 `ctx.tools.register()` 直接注册，而它只接受**已编译的 RAW schema**
  （调 `assertSupportedJsonSchema`），不会像 `defineTool()` 那样把作者 DSL
  （`required: true` 写在属性里）编译成 `required: [...]` 数组。旧 `OUTPUT_SCHEMA`
  里 `accepted.required / targetSessionId.required / code.required / message.required`
  逐条被拒，整条不激活。修法：参数与输出一律写 RAW（`required` 提到对象层），
  与官方 `tool-session-query`（`defineTool` + `{type:'string'}` 输出）及
  `dsh-bili-scroll`（`defineTool` 包一层）的写法对齐。改完需**重启 DSH** 生效。
