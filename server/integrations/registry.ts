import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

export interface IntegrationModule {
  name: string;
  description: string;
  requiredEnv?: string[];
  createServer: (ctx: IntegrationContext) => Promise<McpSdkServerConfigWithInstance>;
}

export interface IntegrationContext {
  conversationId?: string;
}

const registry = new Map<string, IntegrationModule>();

export function registerIntegration(mod: IntegrationModule): void {
  registry.set(mod.name, mod);
}

export function listIntegrations(): IntegrationModule[] {
  return [...registry.values()];
}

export function getIntegration(name: string): IntegrationModule | undefined {
  return registry.get(name);
}

export async function loadIntegrations(): Promise<void> {
  const { registerComposioToolkits } = await import("./composio-loader.js");
  await registerComposioToolkits();
  const loaded = [...registry.keys()];
  console.log(
    `[integrations] loaded: ${loaded.join(", ") || "(none — connect a toolkit from the Debug UI's Connections tab)"}`,
  );
}

export async function refreshIntegrations(): Promise<void> {
  registry.clear();
  await loadIntegrations();
}

export function makeContext(conversationId?: string): IntegrationContext {
  return { conversationId };
}

export async function buildMcpServersForIntegrations(
  names: string[],
  conversationId?: string,
): Promise<Record<string, McpSdkServerConfigWithInstance>> {
  const ctx = makeContext(conversationId);
  // Parallelize: each toolkit's createServer hits Composio (auth config lookup,
  // session create, tool list). Multi-toolkit automations were paying the sum of
  // those latencies; now they pay the max.
  const built = await Promise.all(
    names.map(async (name) => {
      const mod = registry.get(name);
      if (!mod) {
        console.warn(`[integrations] unknown integration: ${name}`);
        return null;
      }
      try {
        const server = await mod.createServer(ctx);
        return [name, server] as const;
      } catch (err) {
        console.error(`[integrations] failed to build ${name}`, err);
        return null;
      }
    }),
  );
  const out: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const entry of built) {
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}
