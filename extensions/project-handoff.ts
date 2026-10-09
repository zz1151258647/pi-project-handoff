/**
 * project-handoff 计数扩展（pi 版）
 *
 * 对应原 project-handoff skill 的 Hook 计数链（Codex hooks / Claude Code hooks）：
 *   PostCompact(auto)  → session_compact（reason !== "manual"）计数
 *   SessionStart/UserPromptSubmit 注入 → before_agent_start 注入状态消息
 *   Stop 核验与补漏   → agent_before_settle 核验最终文本第一段，缺漏时请求补漏一次
 *
 * 职责边界：
 *   - 本扩展只管理计数、冷却、状态注入、展示核验和补漏。
 *   - 「是否值得建议交接」是业务判断，由 project-handoff skill 的评估规则承载，
 *     模型评估后通过 handoff_state 工具登记结果。
 *   - 保存 / 恢复交接材料是 skill 的文件流程，本扩展不写业务文件。
 *
 * 状态文件：~/.pi/agent/state/project-handoff/<sha256(sessionId)>.json
 * （PI_CODING_AGENT_DIR 设置时使用其指向的 agent 目录）
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------- 状态模型 ----------

interface HandoffProposal {
	id: string;
	notice: string;
	reason: "count" | "stage" | "confusion" | "checkpoint" | "manual";
	compactionCount: number;
	stageKey?: string;
	benefit?: string;
	causeKey?: string;
	checkpointKey?: string;
	displayed: boolean;
	verified: boolean;
}

interface HandoffState {
	version: 1;
	sessionId: string;
	/** 自动压缩累计次数（threshold / overflow 计数，manual 不计） */
	autoCompactions: number;
	/** 下一次允许提醒的压缩次数（冷却点） */
	cooldownUntil: number;
	/** 最近一次正式提醒（最终文本核验通过）时的压缩次数 */
	lastReminderCount: number | null;
	/** 到期待评估：模型需用 handoff_state 登记 evaluate/prepare */
	pendingEval: boolean;
	/** 触发评估的原因：压缩检查点或规模检查点 */
	pendingEvalReason: "compaction" | "size" | null;
	/** 上次规模软检查点时的 token 数（再涨约 50% 才提示下一次） */
	lastSizeCheckpointTokens: number | null;
	/** 用户指定的交接节点（到达前不按次数提醒） */
	checkpointKey: string | null;
	/** 用户静默："本任务不提醒" */
	muted: boolean;
	/** 暂缓原因与下次检查时机 */
	deferReason: string | null;
	nextCheck: "next_turn" | "next_compaction" | null;
	/** 当前建议（等待模型在最终答复第一段展示） */
	proposal: HandoffProposal | null;
	updatedAt: string;
}

function defaultState(sessionId: string): HandoffState {
	return {
		version: 1,
		sessionId,
		autoCompactions: 0,
		cooldownUntil: 3,
		lastReminderCount: null,
		pendingEval: false,
		pendingEvalReason: null,
		lastSizeCheckpointTokens: null,
		checkpointKey: null,
		muted: false,
		deferReason: null,
		nextCheck: null,
		proposal: null,
		updatedAt: new Date().toISOString(),
	};
}

// ---------- 状态文件 ----------

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function stateDir(): string {
	return join(agentDir(), "state", "project-handoff");
}

function statePath(sessionId: string): string {
	return join(stateDir(), `${createHash("sha256").update(sessionId).digest("hex")}.json`);
}

function loadState(sessionId: string): HandoffState {
	try {
		const raw = readFileSync(statePath(sessionId), "utf8");
		const parsed = JSON.parse(raw) as HandoffState;
		if (parsed && parsed.version === 1) {
			return { ...defaultState(sessionId), ...parsed, sessionId };
		}
	} catch {
		// 文件不存在或损坏时按新状态处理
	}
	return defaultState(sessionId);
}

function saveState(state: HandoffState): void {
	state.updatedAt = new Date().toISOString();
	mkdirSync(stateDir(), { recursive: true });
	writeFileSync(statePath(state.sessionId), JSON.stringify(state, null, 2), "utf8");
}

/** 清理 60 天未更新的其他会话状态（同原计数脚本的顺手清理） */
function cleanupOldStates(keepSessionId: string): void {
	try {
		const dir = stateDir();
		if (!existsSync(dir)) return;
		const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
		const keep = statePath(keepSessionId);
		for (const name of readdirSync(dir)) {
			if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
			const file = join(dir, name);
			if (file === keep) continue;
			try {
				if (statSync(file).mtimeMs < cutoff) unlinkSync(file);
			} catch {
				// 删除失败不影响计数
			}
		}
	} catch {
		// 清理失败不影响计数
	}
}

// ---------- 文本工具 ----------

/** 从消息中提取纯文本（防御性处理多种消息形状） */
function extractText(message: unknown): string {
	const msg = message as { content?: unknown } | undefined;
	const content = msg?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } => (part as { type?: string })?.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

/** 取正文第一段：跳过引用块、代码块分隔等非正文块 */
function firstProseParagraph(text: string): string {
	for (const block of text.split(/\n\s*\n/)) {
		const t = block.trim();
		if (!t) continue;
		if (t.startsWith(">") || t.startsWith("```") || t.startsWith("---") || t.startsWith("|")) continue;
		return t;
	}
	return "";
}

const NOTICE_PREFIX = "交接建议：";

function validateNotice(notice: string): string | null {
	const t = notice.trim();
	if (!t.startsWith(NOTICE_PREFIX)) return `notice 必须以「${NOTICE_PREFIX}」开头`;
	if (/\n/.test(t)) return "notice 必须是单段，不能换行";
	const len = [...t].length;
	if (len < 20) return `notice 至少 20 字（当前 ${len} 字）`;
	if (len > 600) return `notice 最多 600 字（当前 ${len} 字）`;
	return null;
}

// ---------- 状态文本 ----------

function statusLine(state: HandoffState): string {
	const parts = [`[project-handoff 状态] 自动压缩 ${state.autoCompactions} 次`];
	if (state.lastReminderCount !== null) {
		parts.push(`上次正式提醒在第 ${state.lastReminderCount} 次`);
	}
	if (state.lastSizeCheckpointTokens !== null) {
		parts.push(`规模检查点 ${state.lastSizeCheckpointTokens} tokens`);
	}
	parts.push(`下次检查点第 ${state.cooldownUntil} 次`);
	if (state.muted) parts.push("已静默（本任务不提醒）");
	if (state.checkpointKey) parts.push(`用户指定节点：${state.checkpointKey}`);
	if (state.deferReason) parts.push(`暂缓中：${state.deferReason}`);
	return parts.join("；");
}

/** 规模软检查点阈值：max(50k, 窗口的 50%)，可用 PI_HANDOFF_SIZE_THRESHOLD 覆盖。
 *  1M 窗口约 500k 才提示（长会话常态规模），避免过早打扰。 */
function sizeThreshold(contextWindow: number): number {
	const env = Number(process.env.PI_HANDOFF_SIZE_THRESHOLD);
	if (Number.isFinite(env) && env > 0) return env;
	return Math.max(50_000, Math.floor(contextWindow * 0.5));
}

function injectedStatusText(state: HandoffState): string {
	const lines = [statusLine(state)];
	if (state.pendingEval) {
		const why = state.pendingEvalReason === "size" ? "上下文规模已到检查点，切换收益上升" : "已到压缩检查点";
		lines.push(
			`⚠️ ${why}：请评估是否建议交接——阶段边界（刚完成一个可验收阶段、进入下一大段工作）优先于次数，并用 handoff_state 工具登记结果（evaluate defer/skip 或 prepare 提出建议）。评估结果必须登记，不能省略。`,
		);
	}
	if (state.proposal && !state.proposal.verified) {
		lines.push(
			"⚠️ 有一条已登记但未展示的交接建议：本轮最终答复正文第一段必须原样以「交接建议：」开头展示：" +
				state.proposal.notice,
		);
	}
	return lines.join("\n");
}

// ---------- 扩展主体 ----------

export default function (pi: ExtensionAPI) {
	// 按会话缓存状态（session_start 载入；session_shutdown 丢弃）
	let state: HandoffState | null = null;
	// 补漏防循环：每个用户请求周期（before_agent_start 重置）最多补漏一次
	let catchUpUsed = false;

	function currentSessionId(ctx: ExtensionContext): string {
		try {
			return ctx.sessionManager.getSessionId() ?? "unknown-session";
		} catch {
			return "unknown-session";
		}
	}

	function ensureState(ctx: ExtensionContext): HandoffState {
		const sessionId = currentSessionId(ctx);
		if (!state || state.sessionId !== sessionId) {
			state = loadState(sessionId);
		}
		return state;
	}

	// ---- 会话生命周期 ----

	pi.on("session_start", (_event, ctx) => {
		state = ensureState(ctx);
		catchUpUsed = false;
		cleanupOldStates(state.sessionId);
	});

	pi.on("session_shutdown", () => {
		state = null;
	});

	// ---- 压缩计数：自动压缩（threshold / overflow）计数，manual 不计 ----

	pi.on("session_compact", (event, ctx) => {
		const s = ensureState(ctx);
		if (event.reason === "manual") return;
		s.autoCompactions += 1;
		// 到达检查点：第 3 次首次提醒机会；之后距上次正式提醒满 3 次再检查。
		// 用户静默或指定节点未到时不标记；业务层面的阶段/收益由模型评估。
		if (!s.muted && !s.checkpointKey && s.autoCompactions >= s.cooldownUntil) {
			s.pendingEval = true;
			s.pendingEvalReason = "compaction";
			if (s.nextCheck === "next_compaction") s.nextCheck = null;
		}
		saveState(s);
		cleanupOldStates(s.sessionId);
	});

	// ---- 状态注入：每次用户 prompt 提交后、agent loop 前 ----

	pi.on("before_agent_start", (_event, ctx) => {
		const s = ensureState(ctx);
		catchUpUsed = false;
		// next_turn：暂缓后下一回合重新提示评估
		if (s.nextCheck === "next_turn" && !s.muted) {
			s.pendingEval = true;
			s.pendingEvalReason ??= "compaction";
			s.nextCheck = null;
			saveState(s);
		}
		// 规模软检查点：上下文超过阈值（且距上次标记再涨约 50%）时提示评估一次。
		// 这是 1M 上下文等“压缩几乎不触发”场景的程序化兜底信号。
		if (!s.muted && !s.checkpointKey) {
			const usage = ctx.getContextUsage?.();
			if (usage?.tokens != null && usage.tokens >= sizeThreshold(usage.contextWindow)) {
				const due = s.lastSizeCheckpointTokens === null || usage.tokens >= s.lastSizeCheckpointTokens * 1.5;
				if (due) {
					s.pendingEval = true;
					s.pendingEvalReason = "size";
					s.lastSizeCheckpointTokens = usage.tokens;
					saveState(s);
				}
			}
		}
		// 空闲时不向每次用户请求注入交接内容：这会反复激活 project-handoff skill，
		// 并可能抢占用户明确指定的 /skill 调用。只在真实检查点或有待展示建议时注入。
		if (!s.pendingEval && (!s.proposal || s.proposal.verified)) return;
		return {
			message: {
				customType: "project_handoff_state",
				content: injectedStatusText(s),
				display: false,
			},
		};
	});

	// ---- 最终核验与补漏：settle 是最终可操作边界 ----

	pi.on("agent_before_settle", (event, ctx) => {
		const s = ensureState(ctx);

		// 1) 核验：最终答复正文第一段是否原样展示建议
		if (s.proposal && !s.proposal.verified) {
			const messages = event.context.contextMessages ?? [];
			let lastAssistant = "";
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i] as { role?: string };
				if (msg?.role === "assistant") {
					lastAssistant = extractText(messages[i]);
					break;
				}
			}
			const firstPara = firstProseParagraph(lastAssistant);
			if (firstPara.startsWith(NOTICE_PREFIX)) {
				s.proposal.displayed = true;
				s.proposal.verified = true;
				s.lastReminderCount = s.autoCompactions;
				s.cooldownUntil = s.autoCompactions + 3;
				s.pendingEval = false;
				saveState(s);
			}
		}

		// 2) 补漏：到期待评估未登记，或建议未展示 → 请求模型补一次
		const needCatchUp = s.pendingEval || (s.proposal !== null && !s.proposal.verified);
		if (needCatchUp && !catchUpUsed) {
			catchUpUsed = true;
			const reminder =
				s.pendingEval && s.proposal && !s.proposal.verified
					? "project-handoff：本轮缺少交接评估登记，且有一条建议未在最终答复第一段展示。请补登记 handoff_state 评估结果，并在最终答复第一段原样展示建议。"
					: s.pendingEval
						? "project-handoff：本轮到达交接检查点但未登记评估结果。请按 skill 评估后用 handoff_state 登记（evaluate defer/skip 或 prepare）。"
						: "project-handoff：有一条已登记的交接建议未在最终答复第一段展示。请在最终答复正文第一段原样以「交接建议：」开头展示，或用 handoff_state cancel 作废该建议。";
			return {
				entries: [
					{
						type: "custom_message",
						customType: "project_handoff_reminder",
						content: reminder,
						display: false,
					},
				],
				continue: true,
			};
		}
		return;
	});

	// ---- 登记工具：模型评估后登记结果 ----

	const HandoffStateParams = Type.Object({
		action: Type.Union(
			[
				Type.Literal("status"),
				Type.Literal("evaluate"),
				Type.Literal("prepare"),
				Type.Literal("respond"),
				Type.Literal("cancel"),
				Type.Literal("mute"),
				Type.Literal("resume"),
			],
			{ description: "登记动作" },
		),
		outcome: Type.Optional(
			Type.Union([Type.Literal("defer"), Type.Literal("skip")], {
				description: "evaluate 的结论：暂缓或不适用",
			}),
		),
		note: Type.Optional(Type.String({ description: "简短原因，不超过 160 字，不含用户原文或敏感信息" })),
		next_check: Type.Optional(
			Type.Union([Type.Literal("next_turn"), Type.Literal("next_compaction")], {
				description: "暂缓后的下次检查时机",
			}),
		),
		reason: Type.Optional(
			Type.Union(
				[
					Type.Literal("count"),
					Type.Literal("stage"),
					Type.Literal("confusion"),
					Type.Literal("checkpoint"),
					Type.Literal("manual"),
				],
				{ description: "prepare 的触发原因：count/stage/confusion/checkpoint，或用户主动检查时的 manual" },
			),
		),
		notice: Type.Optional(
			Type.String({ description: "建议原文：以「交接建议：」开头的一段话，20-600 字，含原因、接续第一步、确认后的动作" }),
		),
		stage_key: Type.Optional(Type.String({ description: "稳定的业务阶段标识（reason=stage 时必填）" })),
		benefit: Type.Optional(Type.String({ description: "切换收益的具体描述（reason=stage 时必填）" })),
		cause_key: Type.Optional(Type.String({ description: "已纠正问题的标识（reason=confusion 时必填）" })),
		checkpoint_key: Type.Optional(Type.String({ description: "用户指定节点标识（reason=checkpoint 或 respond defer 时必填）" })),
		proposal_id: Type.Optional(Type.String({ description: "建议编号（respond/cancel 时必填）" })),
		response: Type.Optional(
			Type.Union([Type.Literal("handoff"), Type.Literal("continue"), Type.Literal("defer")], {
				description: "用户对建议的回应",
			}),
		),
		safe: Type.Optional(Type.Boolean({ description: "安全位置：操作已收拢、无半截写入（prepare 时按事实填写）" })),
		has_next: Type.Optional(Type.Boolean({ description: "有明确后续：第一步和完成标准清楚（prepare 时按事实填写）" })),
	});

	type HandoffParams = {
		action: "status" | "evaluate" | "prepare" | "respond" | "cancel" | "mute" | "resume";
		outcome?: "defer" | "skip";
		note?: string;
		next_check?: "next_turn" | "next_compaction";
		reason?: "count" | "stage" | "confusion" | "checkpoint" | "manual";
		notice?: string;
		stage_key?: string;
		benefit?: string;
		cause_key?: string;
		checkpoint_key?: string;
		proposal_id?: string;
		response?: "handoff" | "continue" | "defer";
		safe?: boolean;
		has_next?: boolean;
	};

	function ok(text: string, details: Record<string, unknown>) {
		return {
			content: [{ type: "text" as const, text }],
			details: { ...details, state: state ? JSON.parse(JSON.stringify(state)) : null },
		};
	}

	function fail(text: string, details: Record<string, unknown>) {
		return {
			content: [{ type: "text" as const, text }],
			details: { ...details, error: text, state: state ? JSON.parse(JSON.stringify(state)) : null },
			isError: true as const,
		};
	}

	pi.registerTool({
		name: "handoff_state",
		label: "Handoff State",
		description:
			"project-handoff 交接提醒的登记工具。仅在 project-handoff 流程中使用：" +
			"到达交接检查点时登记评估结果（evaluate），决定提醒时登记建议（prepare），" +
			"用户回应后登记回应（respond），建议作废登记（cancel），静默/恢复（mute/resume），查询（status）。" +
			"提醒、保存、新建接续是三个独立动作，本工具只管提醒链的登记。",
		parameters: HandoffStateParams,
		exposure: "model-only",
		annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },

		async execute(_toolCallId, params: HandoffParams, _signal, _onUpdate, ctx) {
			const s = ensureState(ctx);

			switch (params.action) {
				case "status": {
					return ok(statusLine(s), { action: "status" });
				}

				case "evaluate": {
					if (params.outcome !== "defer" && params.outcome !== "skip") {
						return fail("evaluate 需要 outcome（defer 或 skip）", { action: "evaluate" });
					}
					const note = (params.note ?? "").slice(0, 160);
					s.pendingEval = false;
					s.pendingEvalReason = null;
					s.deferReason = params.outcome === "defer" ? note || "暂缓" : null;
					s.nextCheck = params.outcome === "defer" ? params.next_check ?? "next_turn" : "next_compaction";
					saveState(s);
					return ok(`已登记评估：${params.outcome}${note ? `（${note}）` : ""}；下次检查：${s.nextCheck}`, {
						action: "evaluate",
						outcome: params.outcome,
					});
				}

				case "prepare": {
					const reason = params.reason ?? "count";
					if (s.muted && reason !== "manual") return fail("已静默，不提出主动提醒；用户显式请求检查时允许登记建议", { action: "prepare" });
					if (!params.notice) return fail("prepare 需要 notice", { action: "prepare" });
					const noticeError = validateNotice(params.notice);
					if (noticeError) return fail(noticeError, { action: "prepare" });
					if (params.safe !== true || params.has_next !== true) {
						return fail("prepare 需要 safe 和 has_next 都为 true（安全位置且有明确后续）", { action: "prepare" });
					}
					if (reason === "stage" && (!params.stage_key || !params.benefit)) {
						return fail("reason=stage 需要 stage_key 和 benefit", { action: "prepare" });
					}
					if (reason === "confusion" && !params.cause_key) {
						return fail("reason=confusion 需要 cause_key", { action: "prepare" });
					}
					if (reason === "checkpoint" && !params.checkpoint_key) {
						return fail("reason=checkpoint 需要 checkpoint_key", { action: "prepare" });
					}
					// 信号校验：count 是兜底提醒，需压缩到冷却点或有规模检查点信号；
					// stage/confusion/checkpoint 是阶段/混淆/节点提醒；manual 由用户主动触发，均不受冷却约束。
					if (reason === "count") {
						const compactionDue = s.autoCompactions >= s.cooldownUntil;
						const sizeSignal = s.pendingEval === true && s.pendingEvalReason === "size";
						if (!compactionDue && !sizeSignal) {
							return fail(
								`兜底信号未到：压缩 ${s.autoCompactions}/${s.cooldownUntil}，且无规模检查点信号；阶段提醒请改用 reason=stage`,
								{ action: "prepare" },
							);
						}
					}
					const id = `PH-${Date.now().toString(36)}`;
					s.proposal = {
						id,
						notice: params.notice.trim(),
						reason,
						compactionCount: s.autoCompactions,
						stageKey: params.stage_key,
						benefit: params.benefit,
						causeKey: params.cause_key,
						checkpointKey: params.checkpoint_key,
						displayed: false,
						verified: false,
					};
					s.pendingEval = false;
					s.pendingEvalReason = null;
					s.checkpointKey = null;
					saveState(s);
					return ok(
						`prepared: true。建议已登记（${id}）。现在必须在本轮最终答复正文第一段原样展示该建议，不要放进引用或代码块；仅保存不新建对话。`,
						{ action: "prepare", proposal_id: id, prepared: true },
					);
				}

				case "respond": {
					if (!params.proposal_id || !params.response) {
						return fail("respond 需要 proposal_id 和 response", { action: "respond" });
					}
					if (!s.proposal || s.proposal.id !== params.proposal_id) {
						return fail(`proposal_id 不匹配（当前：${s.proposal?.id ?? "无"}）`, { action: "respond" });
					}
					if (params.response === "handoff" || params.response === "continue") {
						s.cooldownUntil = s.autoCompactions + 3;
						s.deferReason = null;
						s.nextCheck = null;
						if (params.response === "continue") {
							// 用户说“先不交接/继续做”：从回应时再冷却 3 次压缩
							s.pendingEval = false;
						}
						// handoff：业务交接按 handoff.md 流程执行，本工具只停止提醒链
						s.proposal = null;
						saveState(s);
						return ok(`已登记用户回应：${params.response}；冷却至第 ${s.cooldownUntil} 次压缩`, {
							action: "respond",
							response: params.response,
						});
					}
					// defer：用户指定节点
					if (!params.checkpoint_key) {
						return fail("response=defer 需要 checkpoint_key", { action: "respond" });
					}
					s.checkpointKey = params.checkpoint_key;
					s.pendingEval = false;
					s.proposal = null;
					saveState(s);
					return ok(`已登记用户指定节点：${params.checkpoint_key}；到达前不按次数提醒`, {
						action: "respond",
						response: "defer",
					});
				}

				case "cancel": {
					if (!params.proposal_id) return fail("cancel 需要 proposal_id", { action: "cancel" });
					if (!s.proposal || s.proposal.id !== params.proposal_id) {
						return fail(`proposal_id 不匹配（当前：${s.proposal?.id ?? "无"}）`, { action: "cancel" });
					}
					s.proposal = null;
					saveState(s);
					return ok("建议已作废（记为本次跳过，不冒充用户拒绝）", { action: "cancel" });
				}

				case "mute": {
					s.muted = true;
					s.pendingEval = false;
					s.proposal = null;
					saveState(s);
					return ok("已静默：本任务不再主动提醒（显式交接请求仍执行）", { action: "mute" });
				}

				case "resume": {
					s.muted = false;
					s.cooldownUntil = s.autoCompactions + 3;
					saveState(s);
					return ok(`已恢复提醒；冷却至第 ${s.cooldownUntil} 次压缩`, { action: "resume" });
				}

				default:
					return fail(`未知动作：${String(params.action)}`, { action: params.action });
			}
		},
	});

	// ---- 用户命令：主动触发与状态管理 ----

	pi.registerCommand("handoff", {
		description: "项目交接：交接 / 接续 / 检查；不带参数时按“交接”处理",
		handler: (args, ctx) => {
			const input = args.trim();
			const match = input.match(/^(交接|接续|检查)(?:\s+([\s\S]*))?$/);
			const action = match?.[1] ?? "交接";
			const extra = match?.[2]?.trim() ?? (match ? "" : input);
			const isCheck = action === "检查";
			const instruction = action === "接续"
				? `从当前项目既定的交接状态材料恢复上次任务，先只读核对，再继续其中已授权的下一步；不要重复保存交接材料或新建接续材料。缺少状态材料或关键授权不明时先说明阻塞。${extra ? `补充要求：${extra}` : ""}`
				: isCheck
					? `主动检查当前是否值得建议交接。只评估并按规则登记结果，不保存或更新 PROJECT_STATE.md，不创建接续开场白；若确有切换收益且后续明确，可提出交接建议（reason=manual）。${extra ? `补充要求：${extra}` : ""}`
					: `保存当前进度并交付接续开场白。${extra ? `附加要求：${extra}` : ""}`;
			pi.sendUserMessage(`/skill:project-handoff ${instruction}`, { expandPromptTemplates: true });
			ctx.ui.notify(
				isCheck
					? "project-handoff：正在主动评估是否适合交接（不会保存材料）……"
					: action === "接续"
						? "project-handoff：正在恢复并核对上次交接……"
						: "project-handoff：已发起交接，正在整理材料……",
				"info",
			);
		},
	});
}
