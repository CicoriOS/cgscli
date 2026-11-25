// Seeds the distribution defaults into <agentDir>/config.yml before omp starts (its startup discovery reads them).
// Usage: bun scripts/seed-config.ts [extension-entry]    (agent dir from PI_CODING_AGENT_DIR / PI_CONFIG_DIR like omp)
import { resolveAgentDir, seedDistributionDefaults } from "../packages/connect/src/agent-config.ts";

seedDistributionDefaults(resolveAgentDir(), process.argv[2]);
