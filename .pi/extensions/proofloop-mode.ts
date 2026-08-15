/**
 * Proofloop v2 Mode Extension — Brain / Standard 模式切换
 *
 * /brain     → 切换到 Brain orchestration mode
 * /standard  → 切换回 Standard coding mode
 *
 * Brain 模式下，在每次 agent_start 时注入 Brain 工作流指令到 system prompt。
 * 标准模式下，主会话保持完整的 coding agent 能力。
 *
 * 子 agent（pi-subagents）不加载此 extension，不会受到 Brain 指令影响。
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

	// ─── Session 恢复 ──────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// 从 session 历史中恢复 mode 状态
		for (const entry of ctx.sessionManager.getBranch()) {
			if (
				entry.type === "message" &&
				(entry as any).customType === MODE_ENTRY_TYPE
			) {
				state.enabled = (entry as any).content === "active";
				break;
			}
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
			pi.appendEntry({
				customType: MODE_ENTRY_TYPE,
				content: "active",
				display: false,
			});

			ctx.ui.notify("🧠 Brain orchestration mode activated", "info");
			updateStatus(ctx);
		},
	});

	pi.registerCommand("standard", {
		description: "Switch back to Standard coding mode",
		handler: async (_args, ctx) => {
			state.enabled = false;

			// 持久化模式状态到 session
			pi.appendEntry({
				customType: MODE_ENTRY_TYPE,
				content: "inactive",
				display: false,
			});

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
				"Follow the Pi runtime adaptation above: dispatch the listed specialist roles with Pi Agent(...). " +
				"Use this session directly only for DIRECT_BOUNDED_TASK or authority work with loaded skills. " +
				"Do not implement production code yourself — that is the Worker's job.",
		};
	});
}
