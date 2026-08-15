// qmd-autosearch — 自动补搜插件
// 触发：模型在 QMD 集合对应目录内执行 grep/glob（顶层调用）
// 搜索：QMD 单次调用（服务端 LLM 重排），范围限定在配置的 collections
// 查询词：以最近 user 消息（任务要求）为主，grep pattern 仅作词法辅助
// 注入：结果排队到 agent.inbox.nextStep，下一个 pre-step 注入模型上下文
// 配置（必填）：qmdUrl = QMD MCP 服务地址；collections = 搜索范围集合列表
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";

export const name = "qmd-autosearch";

const SEARCH_TOOLS = new Set(["grep", "glob"]);
const INTENT_MAX_CHARS = 300;

function freezeMessage(input) {
	return Object.freeze({
		...input,
		id: input.id ?? randomUUID()
	});
}

function createUserMessage(input) {
	return freezeMessage({
		...input,
		role: "user"
	});
}

// 把 grep 正则 pattern 清洗成 QMD 词法查询（正则元字符 → 空格）
function cleanPattern(pattern) {
	return String(pattern ?? "")
		.replace(/[|()[\]{}*+?^$\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function inRoot(root, path) {
	return path === root || path.startsWith(root + "/") || path.startsWith(root + "\\");
}

// ── QMD MCP 直连（streamable-http）────────────────────────────────────
async function mcpRequest(url, sessionId, method, params) {
	const headers = {
		"Content-Type": "application/json",
		"Accept": "application/json, text/event-stream"
	};
	if (sessionId !== null) headers["mcp-session-id"] = sessionId;
	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
	});
	const nextSessionId = res.headers.get("mcp-session-id") ?? sessionId;
	const text = await res.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		const messages = text
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => JSON.parse(line.slice(5)));
		const error = messages.find((m) => m.error)?.error;
		if (error) throw new Error(error.message);
		payload = messages.find((m) => m.result) ?? { result: void 0 };
	}
	if (payload.error) throw new Error(payload.error.message);
	return { result: payload.result, sessionId: nextSessionId };
}

function extractText(callResult) {
	return (callResult?.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

// 解析 QMD 结果行："#3db89d 97% <collection>/<path>.md - <title>"
function parseHits(text) {
	const hits = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^#([0-9a-f]+)\s+(\d+)%\s+(\S+)\s+-\s+(.+)$/);
		if (m) hits.push({ id: m[1], score: Number(m[2]), path: m[3], title: m[4] });
	}
	return hits;
}

// 解析 status 文本："  - knowledge-concepts-keynes: /abs/path (1016 docs)"（行首允许缩进）
// 返回所有非 null 集合路径（用作触发判断的文件系统范围）
function parseCollectionRoots(statusText) {
	const roots = [];
	for (const line of statusText.split("\n")) {
		const m = line.match(/^\s*-\s+([\w-]+):\s+(null|\/\S+)\s+\(\d+\s+docs?\)/);
		if (m && m[2] !== "null") {
			try {
				roots.push(realpathSync(m[2]));
			} catch {
				roots.push(resolve(m[2]));
			}
		}
	}
	return roots;
}

async function qmdSearch(qmdUrl, collections, intentQuery, pattern, toolName, { limit, minScore }) {
	const lexQuery = cleanPattern(pattern);
	const query = (intentQuery || lexQuery).slice(0, INTENT_MAX_CHARS);
	if (!query) return { query, text: "" };
	const { sessionId } = await mcpRequest(qmdUrl, null, "initialize", {
		protocolVersion: "2025-03-26",
		capabilities: {},
		clientInfo: { name: "qmd-autosearch", version: "0.1.0" }
	});
	const searches = [
		{ type: "vec", query } // 语义主查询：任务/user 要求（权重 2x）
	];
	if (lexQuery && lexQuery !== query) searches.push({ type: "lex", query: lexQuery }); // 词法辅助
	const { result: callResult } = await mcpRequest(qmdUrl, sessionId, "tools/call", {
		name: "query",
		arguments: {
			searches,
			collections,
			limit,
			rerank: true,
			intent: `模型在知识库目录用 ${toolName} 搜索了 "${pattern}"，自动补充语义检索结果`
		}
	});
	const hits = parseHits(extractText(callResult)).filter((hit) => hit.score >= minScore);
	if (hits.length === 0) return { query, text: "" };
	const text = `Found ${hits.length} results for "${query}":\n\n` +
		hits.map((hit) => `#${hit.id} ${hit.score}% ${hit.path} - ${hit.title}`).join("\n");
	return { query, text };
}

function renderSupplement(toolName, pattern, payload) {
	return `<system-reminder>
QMD 语义检索补充：你在知识库目录执行了「${toolName} ${pattern}」，系统已按当前任务要求自动用语义检索（范围限定 QMD 集合，LLM 重排）补搜，查询词「${payload.query}」。结果如下（docid 映射为绝对路径后用 read 读取正文，规则见全局指引）：

${payload.text}
</system-reminder>`;
}

// 从 agent 会话事件中取最近的用户消息文本（任务要求；排除插件/指令注入）
function recentUserText(agent) {
	const nodes = agent.session?.surface?.nodes;
	if (!nodes) return "";
	for (let i = nodes.length - 1; i >= 0; i--) {
		const event = agent.session.events?.[nodes[i]];
		if (event?.type !== "user/message") continue;
		const source = event.data?.source;
		if (source?.kind === "plugin" || source?.kind === "agent-instructions") continue;
		const text = (event.data?.content ?? [])
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(" ")
			.trim();
		if (text) return text;
	}
	return "";
}

// 选择语义主查询词：user 消息足够表达意图时用任务要求，否则回退 grep pattern
// 规则：≥20 字直接采用；10-19 字且包含 pattern 关键词才采用；其余（过短/无关运维消息）回退 pattern
function chooseIntentQuery(userText, pattern) {
	const text = String(userText ?? "").trim();
	const cleaned = cleanPattern(pattern);
	if (!text) return cleaned;
	if (text.length >= 20) return text;
	const tokens = cleaned.split(" ").filter((token) => token.length >= 2);
	if (text.length >= 10 && tokens.some((token) => text.includes(token))) return text;
	return cleaned;
}

// ── 插件主体 ────────────────────────────────────────────────────────────
export function apply(ctx, config) {
	// 必填配置：qmdUrl（QMD MCP 服务地址）、collections（搜索范围集合列表）
	// 缺失时插件禁用并告警——不提供环境相关的默认值（适用于公开发布）
	const qmdUrl = config.qmdUrl ?? "";
	const collections = config.collections ?? [];
	if (!qmdUrl || collections.length === 0) {
		ctx.logger.warn(
			"qmd-autosearch: 未配置 qmdUrl 或 collections，插件已禁用。" +
			"请在 cordis.patch.yml 的 config 中显式指定，例如：\n" +
			"  config:\n" +
			"    qmdUrl: http://localhost:6179/mcp\n" +
			"    collections:\n" +
			"      - <collection-name>"
		);
		return;
	}
	const limit = config.limit ?? 5;
	const minScore = config.minScore ?? 25;
	const seen = new WeakMap();
	// 触发路径池：配置的 triggerRoots 优先；否则从 QMD status 解析集合路径（懒加载）
	let triggerRoots = (config.triggerRoots ?? []).map((p) => {
		try {
			return realpathSync(p);
		} catch {
			return resolve(p);
		}
	});
	let rootsLoaded = false;
	const loadTriggerRoots = async () => {
		if (rootsLoaded || triggerRoots.length > 0) return;
		rootsLoaded = true;
		try {
			const { sessionId } = await mcpRequest(qmdUrl, null, "initialize", {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "qmd-autosearch", version: "0.1.0" }
			});
			const { result } = await mcpRequest(qmdUrl, sessionId, "tools/call", {
				name: "status",
				arguments: {}
			});
			triggerRoots = parseCollectionRoots(extractText(result));
			ctx.logger.info("qmd-autosearch: 触发路径池（来自 QMD 集合）%d 个", triggerRoots.length);
		} catch (error) {
			ctx.logger.warn("qmd-autosearch: 解析 QMD 集合路径失败: %o", error);
		}
	};

	const isOurs = (message) => message.source?.kind === "plugin" && message.source?.plugin === name;

	ctx.on("tools/result", (exec) => {
		if (exec.parent !== void 0) return; // 只处理顶层调用
		if (exec.agent === void 0 || exec.signal?.aborted) return;
		if (!SEARCH_TOOLS.has(exec.name)) return;
		const args = exec.arguments;
		if (typeof args !== "object" || args === null) return;
		const path = typeof args.path === "string" ? args.path : typeof args.cwd === "string" ? args.cwd : "";
		const pattern = typeof args.pattern === "string" ? args.pattern : "";
		if (!path || !pattern) return;
		const resolvedPath = resolve(path);

		loadTriggerRoots().then(() => {
			if (triggerRoots.length === 0) return;
			if (!triggerRoots.some((root) => inRoot(root, resolvedPath) || inRoot(root, path))) return;

			// 防重：同 agent 内同签名只补搜一次
			const sig = `${exec.name}:${resolvedPath}:${pattern}`;
			let cache = seen.get(exec.agent);
			if (cache?.has(sig)) return;
			if (cache === void 0) {
				cache = new Set();
				seen.set(exec.agent, cache);
			}
			cache.add(sig);
			if (cache.size > 32) cache.clear();

			const agent = exec.agent;
			const intentQuery = chooseIntentQuery(recentUserText(agent), pattern);
			qmdSearch(qmdUrl, collections, intentQuery, pattern, exec.name, { limit, minScore })
				.then((payload) => {
					if (!payload.text) return;
					const message = createUserMessage({
						content: [{ type: "text", text: renderSupplement(exec.name, pattern, payload) }],
						source: { kind: "plugin", plugin: name }
					});
					agent.inbox.prepend("next-step", message);
				})
				.catch((error) => {
					ctx.logger.warn("qmd-autosearch: %o", error);
				});
		});
	});

	ctx.on("agent/pre-step", async ({ agent, messages, step }, next) => {
		const decision = await next();
		const pending = agent.inbox.nextStep.filter(isOurs);
		if (pending.length === 0) return decision;
		if (decision.kind === "reject" || (step === 1 && decision.messages.length === 0)) {
			for (const message of pending) agent.inbox.remove(message.id);
			return decision;
		}
		const lastClaimedIndex = decision.messages.findLastIndex((message) => messages.includes(message));
		for (const message of pending) agent.inbox.remove(message.id);
		return {
			kind: "enter",
			messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, ...pending)
		};
	});
}
