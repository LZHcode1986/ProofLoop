import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  const BRAIN_FILE = path.join(process.cwd(), ".omp", "BRAIN.md");
  let mode: "default" | "brain" = "default";
  let brainContent: string | null = null;
  let defaultSystemPrompt: string[] | null = null;

  function loadBrainContent(): string | null {
    try { return fs.readFileSync(BRAIN_FILE, "utf-8"); }
    catch { return null; }
  }

  // 读取并缓存 Brain 指令
  brainContent = loadBrainContent();

  // /brain 命令
  pi.registerCommand("brain", {
    description: "Switch to Brain governance mode (read-only routing & dispatch)",
    handler: async (ctx) => {
      if (!brainContent) {
        brainContent = loadBrainContent();
        if (!brainContent) {
          ctx.ui.notify?.(".omp/BRAIN.md not found", "error");
          return;
        }
      }
      mode = "brain";
      ctx.ui.notify?.("Brain mode activated", "info");
    },
  });

  // /default 命令
  pi.registerCommand("default", {
    description: "Switch to Default coding assistant mode",
    handler: async (ctx) => {
      mode = "default";
      ctx.ui.notify?.("Default mode activated", "info");
    },
  });

  // before_agent_start：Brain 模式时注入 Brain 指令
  pi.on("before_agent_start", (_event, ctx) => {
    if (mode !== "brain") return;
    if (!brainContent) return;

    if (defaultSystemPrompt === null) {
      defaultSystemPrompt = ctx.getSystemPrompt();
    }

    return {
      systemPrompt: [...defaultSystemPrompt, `\n${brainContent}`],
    };
  });

  // tool_call：Brain 模式时阻止编辑工具
  pi.on("tool_call", (event, _ctx) => {
    if (mode !== "brain") return;
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: "Brain mode is read-only. Dispatch to @general via task() for file operations.",
      };
    }
  });
}
