# 计数、评估与登记

仅在需要登记评估／建议／回应，或配置、排查计数扩展时读取。什么时候该提醒以 [SKILL.md](../SKILL.md) 为准，本页只讲登记动作、核验方式和部署。

## 计数与检查点

计数由配套扩展 `extension/project-handoff.ts` 完成，对应原 Hook 方案的事件映射：

| 原 Hook 事件 | pi 扩展事件 | 行为 |
| --- | --- | --- |
| `PostCompact(auto)` | `session_compact`（`reason` 为 `threshold` 或 `overflow`） | 自动压缩数加一。手动 `/compact`、恢复会话、聊天轮数都不计数；同一回合可以发生多次自动压缩 |
| `SessionStart`／`UserPromptSubmit` 注入 | `before_agent_start` | 仅到期待评估或存在未展示建议时注入状态与待办，不在普通提示中持续唤起交接技能 |
| （无对应 Hook，新增） | `before_agent_start` 中的规模软检查点 | 上下文 token 超过 max(50k, 窗口 50%)（1M 窗口约 500k）且距上次标记再涨约 50% 时标记待评估。这是 1M 上下文等“压缩几乎不触发”场景的程序化兜底信号，阈值可用 `PI_HANDOFF_SIZE_THRESHOLD` 覆盖 |
| `Stop` 核验与补漏 | `agent_before_settle` | 核验最终答复正文第一段；缺评估登记或缺展示时请求补漏一次，每回合最多一次 |

- 压缩数或规模到达检查点、且没有用户静默或指定节点时，注入文本标记“已到检查点”，需要一次评估。评估后用登记动作记录结果，使同一检查点不在每轮重查。
- **阶段边界（完成可验收阶段、进入下一大段工作、已核实的混淆）是一等信号**，与压缩次数无关，随时可评估登记 `stage`／`confusion`，不受冷却约束。扩展只提供节奏信号，不识别业务阶段。
- 扩展只管理计数、冷却和展示核验；“是否值得建议交接”的判断始终以 SKILL.md 的评估规则为准。

## 登记动作

登记用模型工具 `handoff_state`（`model-only`，由本 skill 流程调用）。用户侧命令：`/handoff 交接` 保存并交付接续开场白；`/handoff 接续` 恢复当前项目的上次交接；`/handoff 检查` 主动评估但不保存材料。命令会自动调用 skill，用户无需再手写 `/skill` 和长提示词。动作一览：

| 场景 | 参数 |
| --- | --- |
| 查状态 | `action: "status"` |
| 暂缓 | `action: "evaluate"`, `outcome: "defer"`, `note: "<具体缺项>"`, `next_check: "next_turn"`；同阶段没有新收益时改 `"next_compaction"` |
| 不适用 | `action: "evaluate"`, `outcome: "skip"`, `note: "<纯问答、无后续或讨论本 Skill>"` |
| 首次次数提醒 | `action: "prepare"`, `reason: "count"`, `safe: true`, `has_next: true`, `notice: "交接建议：<原因、第一步、确认后的动作>"` |
| 用户主动检查 | `action: "prepare"`, `reason: "manual"`；只在用户执行 `/handoff 检查` 且评估确有切换收益时使用，不受自动提醒静默和冷却限制 |
| 阶段提醒（一等信号） | 同上，`reason: "stage"`，加 `stage_key`、`benefit`；不受冷却约束 |
| 已核实的新混淆 | 同上，`reason: "confusion"`，加 `cause_key`（已纠正问题的标识） |
| 用户指定节点到达 | 同上，`reason: "checkpoint"`，加 `checkpoint_key` |
| 用户确认交接 | `action: "respond"`, `proposal_id`, `response: "handoff"`。只停止提醒链，业务交接仍按 handoff.md 执行 |
| 用户说先不交接 | 同上，`response: "continue"` |
| 用户指定“做完 X 再提醒” | 同上，`response: "defer"`, `checkpoint_key: "<节点>"` |
| 建议失效 | `action: "cancel"`, `proposal_id`，记为本次跳过，不冒充用户拒绝 |
| 静默／恢复 | `action: "mute"` 或 `"resume"`，仅用户明确要求时使用 |

约束：`note` 不超过 160 字，不存用户原文或敏感信息；`notice` 是 20 到 600 字的一段话，以“交接建议：”开头，不能换行；`safe`、`has_next`、`benefit` 必须有事实依据。`prepare` 返回 `prepared: true` 才能展示，被拒绝时核实返回的原因，再登记暂缓或不适用。登记暂缓或不适用会关闭尚未最终展示的旧建议，避免恢复后误补。`reason` 为 `count` 时扩展会校验兜底信号（压缩到冷却点，或规模检查点信号未消化）；`stage`（阶段边界）、`confusion`（已纠正）、`checkpoint`（节点到达）不受冷却约束。

## 最终核验

展示没有人工回执入口，进度消息里出现过建议也不算。`agent_before_settle` 从最终答复文本里取正文第一段（跳过引用和代码块），以“交接建议：”开头才计一次正式提醒并开始 3 次压缩的冷却；文本核验不等于用户已经看到。同一建议的核验只计一次。核验与补漏在每个 settle 周期最多请求补漏一次，模型连续忽略时不再强求，留到下一个检查点。

## 状态与成本

每个会话对应 `~/.pi/agent/state/project-handoff/` 下一个 SHA-256 命名的 JSON 文件（`PI_CODING_AGENT_DIR` 设置时使用其指向的 agent 目录），只存压缩计数、冷却点、规模检查点、暂缓原因、当前建议和用户回应，不存聊天正文。每次自动压缩时顺手删除同目录里 60 天未更新的其他会话状态，只认本扩展生成的 64 位十六进制文件名，当前会话不删；删除失败不影响计数。

扩展不联网、不调模型、不新建业务任务。正常检查不增加模型轮次；只有漏登记或漏展示时，补漏会让模型多回复一次。扩展未加载、事件未触发或业务判断有误时，程序不能保证提醒发生，所以不能宣称零额外用量或零漏报。

## 部署与回退

推荐用 pi 包安装（skill 与扩展一起装好，无需手改 settings）：

```bash
pi install git:github.com/zz1151258647/pi-project-handoff
```

手动安装（不通过 pi 包）：

1. `skills/project-handoff/` 放到 `<agent-dir>/skills/`（默认 `~/.pi/agent/skills/`）。
2. `extensions/project-handoff.ts` 放到 `<agent-dir>/extensions/`（自动发现）；或在 `<agent-dir>/settings.json` 的 `extensions` 数组中注册路径（相对 agent 目录或绝对路径均可）。
3. 运行 `/reload` 或重启 pi 后生效。
4. 验证分五个证据层级，报告时分开说：文件存在、扩展加载（真实会话出现注入消息）、`/handoff` 命令可用、真实会话计数变化、最终答复核验通过。

- 回退：`pi remove git:github.com/zz1151258647/pi-project-handoff`，或删除手动拷贝的文件、从 `extensions` 数组删除该条。状态目录保留。提醒静默和计数重置可通过内部 `handoff_state` 工具管理。
- skill 与配套扩展需一并安装：只复制 `SKILL.md` 不能替代扩展和说明。
