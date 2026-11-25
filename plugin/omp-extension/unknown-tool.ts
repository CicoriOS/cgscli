const UNKNOWN_TOOL_GUIDANCE = Symbol.for("cgscli.unknownToolGuidance");

// ADR 0023. Exact names from the Claude Code tools reference (plus legacy
// names), limited to tools without an omp implementation/equivalent. In
// particular, never intercept read/write/edit, task/Agent, or todo/TodoWrite
// just because their corresponding built-in is disabled for this request.
const unavailableTools: Record<string, true> = {
  ToolSearch: true, WaitForMcpServers: true, ListMcpResourcesTool: true, ReadMcpResourceTool: true,
  EnterPlanMode: true, ExitPlanMode: true, EnterWorktree: true, ExitWorktree: true,
  TaskCreate: true, TaskGet: true, TaskList: true, TaskUpdate: true, TaskOutput: true, TaskStop: true, KillShell: true,
  CronCreate: true, CronDelete: true, CronList: true, ScheduleWakeup: true,
  Monitor: true, PowerShell: true, RemoteTrigger: true, SendMessage: true, ListAgents: true, Workflow: true,
};

/** Private hook contract with omp patch P10; no dependence on omp internals. */
interface UnknownToolRequest {
  api: string;
  name: string;
  tools?: readonly Readonly<{ name: string; description?: string }>[];
}

export function unknownToolGuidance({ api, name, tools }: UnknownToolRequest): string | undefined {
  if (api !== "anthropic-messages" || !Object.hasOwn(unavailableTools, name)) return undefined;
  const unavailable = `Tool ${name} is unavailable for this request.`;
  if (!tools) return unavailable;
  if (tools.length === 0) return `${unavailable} No tools were declared for this request.`;
  const maxChoices = 24;
  const choices = tools.slice(0, maxChoices).map((tool) => {
    const description = tool.description?.replace(/\s+/g, " ").trim() ?? "";
    const summary = description.length > 120 ? `${description.slice(0, 119).trimEnd()}…` : description;
    return summary ? `- ${tool.name}: ${summary}` : `- ${tool.name}`;
  });
  if (tools.length > maxChoices) choices.push(`- … and ${tools.length - maxChoices} other declared tools`);
  return `${unavailable} Use only tools declared for this request:\n${choices.join("\n")}`;
}

export function registerUnknownToolGuidance(): void {
  // Process-wide, like the bundled extension. Reinitialization replaces the
  // same pure formatter; no session/client state or teardown to retain.
  Reflect.set(globalThis, UNKNOWN_TOOL_GUIDANCE, unknownToolGuidance);
}
