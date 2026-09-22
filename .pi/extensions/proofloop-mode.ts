/**
 * Proofloop v2 Mode Extension — Brain / Standard 模式切换
 *
 * /brain     → 切换到 Brain orchestration mode
 * /standard  → 切换回 Standard coding mode
 *
 * Brain 模式下，在每次 agent_start 时注入 Brain 工作流指令到 system prompt。
 * 标准模式下，主会话保持完整的 coding agent 能力。
 *
 * Pi Brain workflow 由 .pi/brain-workflow.md 提供；本 extension 只负责加载与注入。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

const MODE_ENTRY_TYPE = "proofloop:brain_mode";
const BRAIN_WORKFLOW_FILE = ".pi/brain-workflow.md";

interface ModeState {
	enabled: boolean;
	instructions?: string;
}

interface PersistedModeState {
	enabled: boolean;
}

export default function (pi: ExtensionAPI): void {
	let state: ModeState = { enabled: false };

	// ─── 工具函数 ──────────────────────────────────────

	async function loadBrainInstructions(ctx: ExtensionContext): Promise<string | null> {
		const filePath = join(ctx.cwd, BRAIN_WORKFLOW_FILE);
		try {
			await access(filePath);
			const content = await readFile(filePath, "utf-8");
			return content;
		} catch {
			return null;
		}
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.enabled) {
			ctx.ui.setStatus(
				"proofloop-mode",
				ctx.ui.theme.fg("warning", "🧠 Brain Mode"),
			);
		} else {
			ctx.ui.setStatus("proofloop-mode", undefined);
		}
	}

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

	// ─── Session 恢复 ──────────────────────────────────

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
		description: "Switch to Brain orchestration mode — inject Proofloop v2 workflow into system prompt",
		handler: async (_args, ctx) => {
			state.enabled = true;

			// 检查 brain-workflow.md 是否存在
			const exists = await loadBrainInstructions(ctx);
			if (!exists) {
				ctx.ui.notify(
					`⚠️  ${BRAIN_WORKFLOW_FILE} not found. Brain mode enabled without workflow instructions.`,
					"warning",
				);
			}

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

	// ─── System Prompt 注入 ────────────────────────────

	pi.on("before_agent_start", async (event, ctx) => {
		if (!state.enabled) return;

		const instructions = await loadBrainInstructions(ctx);
		if (!instructions) return;

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n---\n" +
				instructions +
				"\n\n---\n**Important**: You are currently in **Brain Orchestration Mode**. " +
				"Use the Pi Brain workflow above: for each cross-Agent dispatch, select the role-specific `.pi/agents/<role>.md` configuration, send the bounded packet through native `Agent`, use `resume` only for the same logical Worker while its durable binding remains current, and read structured output with `get_subagent_result`; failures return a typed blocker, and after each Result Brain re-reads durable facts before the next action. " +
				"Use this session directly only for DIRECT_BOUNDED_TASK or authority work with loaded skills. " +
				"Do not implement production code yourself — that is the Worker's job.",
		};
	});
}
