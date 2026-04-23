import '../loadEnv.js';

// Role-based model selection for enowxai provider.
// Brain tier (planner) gets a high-capability model for reasoning/planning.
// Worker tier (coder, reviewer, scribe) gets a fast, capable model for implementation.
const ENOWXAI_BRAIN_MODEL = process.env.ENOWXAI_BRAIN_MODEL || 'gpt-5.4';
const ENOWXAI_WORKER_MODEL = process.env.ENOWXAI_WORKER_MODEL || 'gemini-2.5-flash';

// xa (router) model — local small model for classification and simple chat.
// Set AGENT_ROUTER_PORT to the port of your local model server (default: 18080).
const AGENT_ROUTER_PORT = parseInt(process.env.AGENT_ROUTER_PORT, 10) || 18080;
const AGENT_ROUTER_MODEL = process.env.AGENT_ROUTER_MODEL || 'local';

function buildEnowxaiProviderConfig({ tier = 'worker', maxTokens, temperature }) {
  return {
    provider: 'enowxai',
    model: tier === 'brain' ? ENOWXAI_BRAIN_MODEL : ENOWXAI_WORKER_MODEL,
    max_tokens: maxTokens,
    temperature,
    tool_calling_mode: 'native',
  };
}

function buildRouterConfig() {
  return {
    provider: 'local',
    base_url: `http://127.0.0.1:${AGENT_ROUTER_PORT}`,
    model: AGENT_ROUTER_MODEL,
    max_tokens: 512,
    temperature: 0.1,
  };
}

export const DEFAULT_AGENT_DEFINITIONS = [
  {
    name: 'planner',
    role: 'Breaks work into steps, decides handoffs, and writes plans.',
    model_tier: 'brain',
    system_prompt: [
      'You are planner, the lead architect inside an AI Agent Room.',
      'Understand the request, decide what files are needed, and hand work to other agents using @agent_name mentions.',
      'Prefer writing plan.md or docs/notes when structure is needed.',
      'Be proactive in coordinating other agents when the room needs momentum or a decision.',
    ].join(' '),
    tools: ['list_files', 'read_file', 'write_file', 'update_file'],
    provider_config: buildEnowxaiProviderConfig({ tier: 'brain', maxTokens: 8192, temperature: 0.3 }),
    router_config: buildRouterConfig(),
  },
  {
    name: 'coder',
    role: 'Implements code, scripts, configs, and small project scaffolding.',
    model_tier: 'worker',
    system_prompt: [
      'You are coder, the implementation specialist inside an AI Agent Room.',
      'Write or update files directly in the workspace. Keep edits focused and practical.',
      'Hand off to @reviewer when implementation is ready for checking.',
      'React to plans, reviews, and proposals when your implementation skills are relevant.',
    ].join(' '),
    tools: ['list_files', 'read_file', 'write_file', 'update_file', 'run_python'],
    provider_config: buildEnowxaiProviderConfig({ tier: 'worker', maxTokens: 4096, temperature: 0.2 }),
    router_config: buildRouterConfig(),
  },
  {
    name: 'reviewer',
    role: 'Reviews outputs, checks consistency, and writes review notes.',
    model_tier: 'worker',
    system_prompt: [
      'You are reviewer, the quality and risk checker inside an AI Agent Room.',
      'Review files already written, call out gaps, and write concise review notes when needed.',
      'Use @coder only when a concrete fix is still needed.',
      'Critique proposals and implementation details when the room needs a decision or risk check.',
    ].join(' '),
    tools: ['list_files', 'read_file', 'write_file', 'run_python'],
    provider_config: buildEnowxaiProviderConfig({ tier: 'worker', maxTokens: 4096, temperature: 0.2 }),
    router_config: buildRouterConfig(),
  },
  {
    name: 'scribe',
    role: 'Summarizes progress, prepares handoff notes, and cleans up docs.',
    model_tier: 'worker',
    system_prompt: [
      'You are scribe, the documentation and summary specialist inside an AI Agent Room.',
      'Write concise summaries, changelogs, and human-readable notes inside the workspace.',
      'Capture decisions and progress when multiple agents have moved the work forward.',
    ].join(' '),
    tools: ['list_files', 'read_file', 'write_file'],
    provider_config: buildEnowxaiProviderConfig({ tier: 'worker', maxTokens: 4096, temperature: 0.2 }),
    router_config: buildRouterConfig(),
  },
];

export function buildDefaultAgents(uuidFactory) {
  return DEFAULT_AGENT_DEFINITIONS.map((agent) => ({
    id: uuidFactory(),
    ...agent,
  }));
}