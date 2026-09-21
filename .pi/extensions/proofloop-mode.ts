/**
 * Proofloop v2 Mode Extension — Brain / Standard 模式切换（Pi thin host adapter）
 *
 * /brain     → 切换到 Brain orchestration mode
 * /standard  → 切换回 Standard coding mode
 *
 * 本 extension 是 thin host adapter：只负责 mode persistence、session restore，
 * 以及 Brain mode 下向 system prompt 追加一段短固定 Brain pointer。
 * 它不读取、不注入任何 Brain workflow 正文；route / dispatch / recovery /
 * arbitration 语义由 canonical Brain Workflow Contract
 * （.agents/contracts/brain/workflow.md）定义，不在本 extension 中复制。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODE_ENTRY_TYPE = "proofloop:brain_mode";

// Canonical Brain 事实来源路径（仅作 prompt pointer 引用，不读取文件内容）。
const BRAIN_WORKFLOW_CONTRACT = ".agents/contracts/brain/workflow.md";

interface ModeState {
	enabled: boolean;
}

interface PersistedModeState {
	enabled: boolean;
}

// Brain mode 下追加的短固定提示：只引用 canonical workflow 路径，
// 不包含 workflow body、transition table、reasoning sequence 或 reread loop。
// 末尾的 `<!-- magic-context: skip -->` 是 Magic Context 官方 per-agent opt-out marker：
// 只跳过注入 Brain system prompt 的 Magic Context primary guidance；Magic Context 的上下文管理、
// M0/M1 历史注入与 `ctx_reduce` / `ctx_search` / `ctx_note` 工具保持可用。
const BRAIN_MODE_PROMPT = `You are the Proofloop Brain. Follow the canonical Brain workflow at \`${BRAIN_WORKFLOW_CONTRACT}\`.

<!-- magic-context: skip -->`;
export default function (pi: ExtensionAPI): void {
	let state: ModeState = { enabled: false };

	// ─── UI / 状态 ──────────────────────────────────────

	function updateStatus(ctx: ExtensionContext): void {
		if (state.enabled) {
			ctx.ui.setStatus("proofloop-mode", ctx.ui.theme.fg("warning", "🧠 Brain Mode"));
		} else {
			ctx.ui.setStatus("proofloop-mode", undefined);
		}
	}

	// ─── Session 持久化 / 恢复 ──────────────────────────

	function readPersistedMode(entry: unknown): boolean | undefined {
		if (!entry || typeof entry !== "object") return undefined;

		const candidate = entry as {
			type?: unknown;
			customType?: unknown;
			data?: unknown;
		};
		if (candidate.type !== "custom") return undefined;

		if (candidate.customType === MODE_ENTRY_TYPE) {
			if (!candidate.data || typeof candidate.data !== "object") return undefined;
			const data = candidate.data as Partial<PersistedModeState>;
			return typeof data.enabled === "boolean" ? data.enabled : undefined;
		}

		// legacy 兼容：旧 entry 以 { customType: { customType, content: "active"|"inactive" } } 存储。
		if (candidate.customType && typeof candidate.customType === "object") {
			const legacy = candidate.customType as {
				customType?: unknown;
				content?: unknown;
			};
			if (legacy.customType !== MODE_ENTRY_TYPE) return undefined;
			if (legacy.content === "active") return true;
			if (legacy.content === "inactive") return false;
		}

		return undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		// 从当前 branch 的最新 mode entry 恢复状态。
		state.enabled = false;
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i -= 1) {
			const enabled = readPersistedMode(branch[i]);
			if (enabled === undefined) continue;
			state.enabled = enabled;
			break;
		}
		updateStatus(ctx);
	});

	// ─── 命令注册 ──────────────────────────────────────

	pi.registerCommand("brain", {
		description: "Switch to Brain orchestration mode — append canonical Brain pointer to system prompt",
		handler: async (_args, ctx) => {
			state.enabled = true;

			// 持久化模式状态到 session
			pi.appendEntry(MODE_ENTRY_TYPE, { enabled: true } satisfies PersistedModeState);

			ctx.ui.notify("🧠 Brain orchestration mode activated", "info");
			updateStatus(ctx);
		},
	});

	pi.registerCommand("standard", {
		description: "Switch back to Standard coding mode",
		handler: async (_args, ctx) => {
			state.enabled = false;

			// 持久化模式状态到 session
			pi.appendEntry(MODE_ENTRY_TYPE, { enabled: false } satisfies PersistedModeState);

			ctx.ui.notify("💻 Standard coding mode restored", "info");
			updateStatus(ctx);
		},
	});

	// ─── System Prompt 注入（仅 Brain mode；只追加短固定 pointer）─────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.enabled) return;

		return {
			systemPrompt: event.systemPrompt + "\n\n---\n" + BRAIN_MODE_PROMPT,
		};
	});
}
