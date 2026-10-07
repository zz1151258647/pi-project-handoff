/**
 * project-handoff 提醒链模拟测试（不联网、不调模型）
 * 用法：node simulate.test.js [扩展文件路径]
 * 可用 PI_NODE_MODULES 指向 pi 安装的 node_modules。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

// 解析 pi 运行时的 node_modules（必须在覆盖 PI_CODING_AGENT_DIR 之前）
function findPiNodeModules() {
	if (process.env.PI_NODE_MODULES) return process.env.PI_NODE_MODULES;
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const releasesDir = path.join(agentDir, "install", "releases");
	try {
		const versions = fs.readdirSync(releasesDir).sort();
		for (let i = versions.length - 1; i >= 0; i--) {
			const nm = path.join(releasesDir, versions[i], "node_modules");
			if (fs.existsSync(path.join(nm, "jiti"))) return nm;
		}
	} catch {
		// 找不到时直接报错
	}
	throw new Error("找不到 pi 的 node_modules；请设置 PI_NODE_MODULES 环境变量");
}
const NM = findPiNodeModules();

const extPath = process.argv[2] || path.join(__dirname, "..", "extensions", "project-handoff.ts");
// 隔离测试状态目录，不影响真实状态
process.env.PI_CODING_AGENT_DIR = path.join(os.tmpdir(), "ph-test-agent");
const { createJiti } = require(NM + "/jiti");

function assert(cond, label) {
	if (cond) console.log("  ✓", label);
	else {
		console.error("  ✗", label);
		process.exitCode = 1;
	}
}

(async () => {
	const jiti = createJiti(NM + "/", {
		moduleCache: false,
		alias: {
			typebox: NM + "/typebox/build/index.mjs",
			"@earendil-works/pi-coding-agent": NM + "/@earendil-works/pi-coding-agent/dist/index.js",
		},
	});
	const factory = await jiti.import(extPath, { default: true });

	const handlers = {};
	let tool, command;
	factory({
		on: (ev, h) => (handlers[ev] = h),
		registerTool: (t) => (tool = t),
		registerCommand: (n, o) => (command = { name: n, ...o }),
	});

	let fakeUsage = undefined;
	const fakeCtx = {
		sessionManager: { getSessionId: () => "test-session-1" },
		ui: { notify: () => {} },
		getContextUsage: () => fakeUsage,
	};
	const settle = (text) =>
		handlers["agent_before_settle"]({
			context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text }] }] },
		}, fakeCtx);

	console.log("1) 会话启动与压缩计数");
	handlers["session_start"]({ type: "session_start" }, fakeCtx);
	handlers["session_compact"]({ reason: "threshold" }, fakeCtx);
	handlers["session_compact"]({ reason: "overflow" }, fakeCtx);
	handlers["session_compact"]({ reason: "manual" }, fakeCtx); // 手动不计
	handlers["session_compact"]({ reason: "threshold" }, fakeCtx);
	let r = handlers["before_agent_start"]({}, fakeCtx);
	assert(r.message.customType === "project_handoff_state", "注入状态消息");
	assert(r.message.content.includes("自动压缩 3 次"), "计数为 3（manual 不计）");
	assert(r.message.content.includes("已到压缩检查点"), "第 3 次标记待评估");

	console.log("2) 暂缓登记");
	let res = await tool.execute("t1", { action: "evaluate", outcome: "defer", note: "缺验收标准", next_check: "next_turn" }, undefined, undefined, fakeCtx);
	assert(res.details.state.pendingEval === false, "pendingEval 清除");
	r = handlers["before_agent_start"]({}, fakeCtx);
	assert(r.message.content.includes("已到压缩检查点"), "next_turn 下一回合重新提示");
	r = handlers["before_agent_start"]({}, fakeCtx);

	console.log("3) 提出建议");
	res = await tool.execute("t2", { action: "prepare", reason: "count", notice: "交接建议：" + "甲".repeat(30), safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.details.prepared === true && res.details.proposal_id, "prepared: true");
	const pid = res.details.proposal_id;
	let s = settle("这轮普通回复，没有建议。");
	assert(s && s.continue === true, "未展示 → 补漏一次");
	s = settle("还是没有展示。");
	assert(s === undefined || s.continue !== true, "同周期不重复补漏");
	r = handlers["before_agent_start"]({}, fakeCtx);
	assert(r.message.content.includes("未展示的交接建议"), "注入待展示提醒");

	console.log("4) 最终核验");
	s = settle("交接建议：" + "甲".repeat(30) + "\n\n其余成果列表……");
	assert(s === undefined || s.continue !== true, "展示后无需补漏");
	res = await tool.execute("t3", { action: "status" }, undefined, undefined, fakeCtx);
	assert(res.details.state.proposal && res.details.state.proposal.verified === true, "建议已核验（保留为历史）");
	assert(res.details.state.lastReminderCount === 3, "正式提醒计数为第 3 次");
	assert(res.details.state.cooldownUntil === 6, "冷却至第 6 次");

	console.log("5) 兜底信号校验");
	res = await tool.execute("t4", { action: "prepare", reason: "count", notice: "交接建议：" + "乙".repeat(30), safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.isError === true && res.content[0].text.includes("兜底信号未到"), "兜底信号未到时拒绝 count 提醒");
	res = await tool.execute("t4b", { action: "prepare", reason: "stage", stage_key: "s-phase-1", benefit: "探索完成，后续执行可分开", notice: "交接建议：" + "子".repeat(30), safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.details.prepared === true, "stage 不受冷却约束");
	await tool.execute("t4c", { action: "cancel", proposal_id: res.details.proposal_id }, undefined, undefined, fakeCtx);

	console.log("6) 用户回应与静默");
	res = await tool.execute("t5", { action: "prepare", reason: "confusion", cause_key: "ver-confusion", notice: "交接建议：" + "丙".repeat(30), safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.details.prepared === true, "confusion 不受冷却约束");
	res = await tool.execute("t6", { action: "respond", proposal_id: res.details.proposal_id, response: "continue" }, undefined, undefined, fakeCtx);
	assert(res.details.state.proposal === null && res.details.state.cooldownUntil === 6, "回应 continue 归档建议并保持冷却");
	await tool.execute("t7", { action: "mute" }, undefined, undefined, fakeCtx);
	res = await tool.execute("t8", { action: "prepare", reason: "count", notice: "交接建议：" + "丁".repeat(30), safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.isError === true, "静默中拒绝提醒");
	await tool.execute("t9", { action: "resume" }, undefined, undefined, fakeCtx);

	console.log("7) notice 格式校验");
	res = await tool.execute("t10", { action: "prepare", reason: "stage", stage_key: "s1", benefit: "b", notice: "交接建议：太短", safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.isError === true, "过短 notice 被拒");
	res = await tool.execute("t11", { action: "prepare", reason: "stage", stage_key: "s1", benefit: "b", notice: "没有前缀" + "戊".repeat(30), safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.isError === true, "缺前缀 notice 被拒");

	console.log("8) 规模软检查点（1M 窗口阈值 500k）");
	fakeUsage = { tokens: 480000, contextWindow: 1000000, percent: 48 };
	r = handlers["before_agent_start"]({}, fakeCtx);
	assert(!r.message.content.includes("规模已到检查点"), "480k 未到阈值不标记");
	fakeUsage = { tokens: 520000, contextWindow: 1000000, percent: 52 };
	r = handlers["before_agent_start"]({}, fakeCtx);
	assert(r.message.content.includes("上下文规模已到检查点"), "520k 触发规模检查点");
	res = await tool.execute("t12", { action: "prepare", reason: "count", notice: "交接建议：" + "己".repeat(30), safe: true, has_next: true }, undefined, undefined, fakeCtx);
	assert(res.details.prepared === true, "规模信号下允许 count 兜底提醒");
	await tool.execute("t13", { action: "cancel", proposal_id: res.details.proposal_id }, undefined, undefined, fakeCtx);
	r = handlers["before_agent_start"]({}, fakeCtx);
	assert(!r.message.content.includes("规模已到检查点"), "同规模不重复触发（1.5x 规则）");
	fakeUsage = { tokens: 800000, contextWindow: 1000000, percent: 80 };
	r = handlers["before_agent_start"]({}, fakeCtx);
	assert(r.message.content.includes("上下文规模已到检查点"), "再涨 50% 后再次触发");

	console.log(process.exitCode ? "\n有断言失败" : "\n全部通过");
})();
