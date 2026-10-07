# pi-project-handoff

项目交接 skill + 交接提醒计数扩展，用于 **pi coding agent**。解决长任务换会话时丢失定稿位置、已否决方案、真实进度和下一步的问题：把影响接续的信息整理成 `PROJECT_STATE.md`，让接手会话先核对再继续，不用重述，也不会两个会话同时改。

移植自 [duoduoler-ops/Table-skills](https://github.com/duoduoler-ops/Table-skills) 的 `project-handoff`（原面向 Codex / Claude Code 的 Hook 方案），改为 pi 原生的扩展事件实现。

## 功能

- **保存交接材料**：目标、有效决定、关键文件、真实进度、下一步和验收方法，增量更新，不复制整段聊天。
- **接续开场白**：pi 无自动新建会话能力，保存后交付可复制的开场白，新会话粘贴即恢复（先只读核对再动手）。
- **交接提醒（三个独立动作，互不授权）**：
  - 阶段边界是一等信号：完成可验收阶段、进入下一大段工作、已核实的混淆，随时评估，不等冷却；
  - 兜底节奏：第 3 次自动压缩后、或上下文规模到检查点（1M 窗口约 500k，可调）时评估一次；
  - 建议以「交接建议：」放在最终答复第一段，扩展核验展示后才计一次正式提醒。

## 安装

一键安装（skill 与扩展一起装好）：

```bash
pi install git:github.com/zz1151258647/pi-project-handoff
```

手动安装：

1. `skills/project-handoff/` 拷到 `<agent-dir>/skills/`（默认 `~/.pi/agent/skills/`）
2. `extensions/project-handoff.ts` 拷到 `<agent-dir>/extensions/`（自动发现）
3. `/reload` 或重启 pi

验证：`/handoff-state` 能弹出状态面板即扩展已加载；skill 会出现在启动时的可用 skill 列表。

## 使用

| 入口 | 效果 |
|---|---|
| `/handoff` | 一键交接：整理材料写入 `PROJECT_STATE.md`，交付接续开场白 |
| `/handoff 只评估要不要交接，先不保存` | 命令可带自由指令 |
| "保存一下进度" / "整理交接材料" | 同 `/handoff` |
| `/skill:project-handoff <指令>` | 显式加载 skill 并带指令 |
| `/handoff-state` | 查看压缩计数、规模检查点、待办 |
| `/handoff-state mute` / `resume` / `reset` | 静默 / 恢复 / 重置提醒 |
| "读 PROJECT_STATE.md 继续上次" | 新会话恢复（也可粘贴开场白） |

接续流程：`/handoff` → 拿到材料路径和开场白 → 在项目目录开新 pi 会话 → 粘贴开场白 → 新会话核对后继续。

## 触发提醒的信号

| 信号 | 时机 | 是否受冷却约束 |
|---|---|---|
| 阶段边界 | 完成一个可验收阶段 / 进入下一大段工作 | 否（同阶段改版本、调参不算新阶段） |
| 已纠正的混淆 | 目标或版本混淆被核实时 | 否（同一问题只提醒一次） |
| 压缩兜底 | 第 3 次自动压缩起（手动 `/compact` 不计） | 是（间隔 3 次压缩） |
| 规模兜底 | 上下文超过 max(50k, 窗口 50%)，再涨约 50% 再提示 | 否（1M 窗口约 500k 起） |

阈值可用环境变量 `PI_HANDOFF_SIZE_THRESHOLD` 覆盖（绝对 token 数）。提醒只是建议——用户不点头不会写文件、不会换会话。

## 目录结构

```
├── package.json                 # pi 包声明
├── extensions/
│   └── project-handoff.ts       # 计数扩展：压缩/规模检查点、状态注入、展示核验、补漏
├── skills/
│   └── project-handoff/
│       ├── SKILL.md             # 入口、评估规则、展示规则
│       ├── references/
│       │   ├── handoff.md       # 保存 / 接续 / 恢复流程
│       │   └── counter.md       # 登记动作、核验方式、部署与回退
│       └── assets/
│           └── PROJECT_STATE.template.md
└── tests/
    └── simulate.test.js         # 提醒链模拟测试（25 项断言）
```

## 测试

```bash
node tests/simulate.test.js
```

不联网、不调模型。默认在 `<agent-dir>/install/releases/*/node_modules` 里找 pi 运行时，也可用 `PI_NODE_MODULES` 环境变量指定。

## 验证证据层级

报告问题时请分开说明：文件存在、扩展加载、`/handoff-state` 可用、真实会话计数变化、最终答复核验通过——这五层是不同的证据。扩展未加载或事件未触发时程序不保证提醒发生。

## 卸载

```bash
pi remove git:github.com/zz1151258647/pi-project-handoff
```

手动安装则删除拷贝的两个文件即可。状态目录 `<agent-dir>/state/project-handoff/` 保留（可手动删）。

## 致谢

skill 的交接材料规范、评估三条件（安全位置 / 明确后续 / 切换收益）和「提醒、保存、接续三动作分离」的设计来自 [duoduoler-ops/Table-skills · project-handoff](https://github.com/duoduoler-ops/Table-skills)，版权归其作者所有（MIT）。

## License

MIT，见 [LICENSE](LICENSE)。
