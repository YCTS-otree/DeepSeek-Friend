// Minimal native DSH kernel; no Basic Compaction, shell, filesystem or channel plugins.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createNativeKernel(modulesPath, persistenceRoot, { system = '', complete = true } = {}) {
  const modules = path.resolve(modulesPath, '@deepseek-ai');
  const load = async name => import(pathToFileURL(path.join(modules, name, 'lib/index.js')));
  const { Context } = await load('cordis');
  const sessionModule = await load('dsh-session');
  const llmModule = await load('dsh-llm');
  const ctx = new Context();
  const construct = async (name, config) => { const m = await load(name); return new m.default(ctx, config); };
  await construct('dsh-session');
  await construct('dsh-session-projection');
  await construct('dsh-agent');
  await construct('dsh-llm');
  await construct('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: '' });
  ctx.systemPrompt.section({ name: 'mnn:original-system', order: 0, complete, interpolate: false, text: system });
  await construct('dsh-tools', {});
  await construct('dsh-token-meter', {});
  const persistence = await construct('dsh-session-persistence-jsonl', { root: persistenceRoot });
  // Programmatic construction receives the resolved Volatile interface, unlike Loader YAML.
  const loop = await construct('dsh-agent-loop', { agents: [], maxParallelToolCalls: { get: () => 1 } });
  return { ctx, loop, persistence, load, llmModule, sessionModule };
}

export async function registerRemoteProvider(kernel, dsfRoot, {contextWindow=1048576,maxTokens=2048,thinking='disabled'}={}) {
  const { apiKeyEnvironment } = await import(pathToFileURL(path.join(dsfRoot, 'scripts/runtime-options.js')));
  const { env } = apiKeyEnvironment(dsfRoot);
  if (!env.DEEPSEEK_API_KEY) throw Error('provider-credential-unavailable');
  const { DeepSeekAdapter, resolveAdapterOptions } = await kernel.load('dsh-llm-deepseek');
  const options = resolveAdapterOptions({ baseURL: 'https://api.deepseek.com/anthropic', thinking, reasoningEffort: 'off',
    maxTokens, models: [{id:"deepseek-flash",contextWindow,maxTokens,inputModalities:["text","image"]}], defaultContextWindow: contextWindow, streamIdleTimeoutMs: 120000 });
  const adapter = new DeepSeekAdapter({ options: () => options, resolveAuth: async () => ({ headers: { 'x-api-key': env.DEEPSEEK_API_KEY } }),
    resolveUserId: () => 'mnn-isolated-recovery', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
  kernel.ctx.llm.registerAdapter(['deepseek-official'], adapter);
  return adapter;
}
