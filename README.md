# dsh-session-send（会话直发）

向本 profile 里的另一个会话即时发送文本消息。`session_send` 把消息作为
**Agent 转递（relay）** 投进目标会话 inbox 并唤醒它——目标没开着也行，会被 resume。

投递形状与 teammate / 定时任务同族：消息带着
`source: { kind: 'agent-message', form: 'relay', senderSessionId }`，聊天记录里渲染成一条
**可折叠的「Agent 消息」触发行**（图标 + 标题，点开才看正文），而不是伪装成用户手打的消息。

## 工具

`session_send(target_session_id? | target?, text, mode?, list?)`

- 目标寻址三种方式：
  - `target_session_id`：精确 id（侧栏复制、或先 `list:true` 拿）；
  - `target`：id / **标题子串**（不区分大小写，按 Host 列表里的标题匹配）/ `"latest"`（最近活跃的另一个会话）；
  - `list: true`：不发送，返回候选会话 `[{id,title,cwd,updatedAt,running}]`（最多 30 条），标识符未知时先查。
- 多个标题命中不会瞎猜：返回 `code: "target_ambiguous"` + `candidates`（最多 10 条 id/title），换精确 id 重试。
- `text`：非空、≤8000 字符的纯文本（不支持图片/文件 receipt）；`list:true` 时可省略。
- `mode`：**默认 `steer`**——目标空闲就起一个 turn，目标在跑就在它的下一步边界插话；`queue` 是等它当前 turn 跑完再处理。
  行配置 `defaultMode: queue` 可把默认改回排队。
- 成功：`{"accepted":true,"targetSessionId":"…","targetCwd":"…","resumed":true|false,"mode":"steer|queue"}`；
  `resumed` 表示目标当时没在这个进程里开着（冷会话被唤醒）。
- 失败：`{code,message}`，code 含
  `invalid_text / invalid_target / unauthorized / target_archived / target_not_found /
  target_busy / target_conflict / target_unmigrated / session_index_unavailable /
  delivery_failed / subagent_session / internal_error`。

## 鉴权与目标解析

1. 调用方须是顶层 agent（`delegationDepth>0` 拒绝，防传递扇出）。
2. 目标解析分两路：活会话走 `ctx.agents`；老/冷会话走
   `ctx.sessionPersistence.stat()` 读持久化 header（**不再依赖 `ctx.sessionQuery`**）。
3. 默认**不限制同目录**：本 profile 的任意普通会话都能互发（同一台机器、同一个用户）。
   想恢复旧行为（必须同 cwd）可在行配置里加 `sameWorkspaceOnly: true`。
4. 归档目标直接拒绝（prompt 本体不拦，但 archived gate 会让 turn 以 blocked 结束）；
   `formatStatus === 'migration-required'` 的会话拒绝并提示先迁移。

## 安装

```sh
# 从 GitHub 装入某个 profile（安装后按提示重启或用插件页确认 active）
dsh plugin --profile desktop add github:ModerRAS/dsh-session-send

# 或从本地 tgz
dsh plugin --profile desktop add ./local-dsh-session-send-1.4.1.tgz
```

兼容性：面向 DeepSeek Harness 0.2.2-rc.x（desktop profile 实测 rc.3）。
插件只用 `ctx` 服务与 `node:crypto`，没有 `@deepseek-ai/*` 顶层 import。

## 安装后

桌面版加载 Host JS：`link:` 的包改完代码需要重启；`file:` tgz 覆盖安装会热更。
装完在插件页确认 `session-send` 为 active，或看工具目录里有没有 `session_send`。

## 修复记录

- v1.0.1（2026-11-10）：修 `session-send … did not activate: JsonSchemaError`。
  原因：插件用 `ctx.tools.register()` 直接注册，而它只接受**已编译的 RAW schema**
  （调 `assertSupportedJsonSchema`），不会像 `defineTool()` 那样把作者 DSL
  （`required: true` 写在属性里）编译成 `required: [...]` 数组。修法：参数与输出一律写
  RAW（`required` 提到对象层）。
- v1.2.0（2026-11-16）：修「老会话发不进去」。
  - 旧版冷会话路径用 `ctx.sessionQuery.filterSessions()` 做同 cwd 鉴权；本 profile 的
    session query 不可用（`session_search` 返回 `SESSION_QUERY_PERSISTENCE_FAILED`），
    任何**冷**会话都会被判成 `unauthorized`/`delivery_failed`，而活会话走
    `ctx.agents` 快路径正常——正好是「新会话能发、老会话不能」。
  - 改为 `ctx.sessionPersistence.stat()` 读 header 解析目标，`sessionQuery` 从
    `inject` 中移除。
  - 默认放开跨工作区（旧版要求调用者与目标 cwd 完全相等），保留 `sameWorkspaceOnly` 开关。
  - 新增 `target_busy / target_conflict / target_unmigrated / session_index_unavailable`
    失败码，`accepted` 回执带 `targetCwd` 与 `resumed`。
- v1.2.1（2026-11-16）：投递模式默认改为 `steer`（空闲起 turn、忙碌在下一步边界插话），
  回执带 `mode`；行配置 `defaultMode: queue` 可恢复排队默认。
- v1.3.0（2026-11-16）：投递格式改为 **Agent relay**（可折叠行）。
  - 旧版走 `ctx.sessionController.prompt()`，它构造的是 `source: { kind: 'user' }`，聊天记录里
    和用户亲手输入的完全一样。
  - 新版自己 `ctx.sessionController.resolveAgent(id)` 拿到 Agent（冷会话顺带 resume），再
    `agent.steer/followup({ role:'user', content, source:{ kind:'agent-message', form:'relay', senderSessionId } })`，
    `ctx.sessions.flush()` 落盘后返回。
  - 该 source 正是 subagent/teammate 转递用的形状：客户端 `turnTriggerDetails` 把它映射为
    “Agent 消息” 触发行，`TurnTriggerNodeView` 是带 `aria-expanded` 的折叠头；
    `form: 'relay'` 是 `ContextForm` 里“另一个 agent 发给本 agent 的消息”的语义值。
  - 正文前缀 `Session <发送方 id> sent a message: `，与 subagent 的 `Agent <name> sent a message: ` 对齐。
- v1.4.0（2026-11-16）：目标寻址与发现。
  - 新增 `list:true`：读 `ctx.sessionController.list()`（侧栏同一接口，带 `projections.values.title` 标题），
    失败时退回 `ctx.sessionPersistence.list()`（只有 id/cwd/createdAt，无标题）。
  - 新增 `target`：id / 标题子串 / `"latest"`；多命中返回 `target_ambiguous` + `candidates`。
  - 参数 `required` 去掉（list 模式不需要 text），改为运行时校验。
- v1.4.1（2026-11-16）：`list` 允许子代理调用（只读、便于发现目标）；发送仍限顶层 agent。
  实测 `ctx.sessionController.list()` 可在 Host 侧直调：返回 30 条带标题的行。

## License

MIT
