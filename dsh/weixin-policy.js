// DSH supplies both the registry restriction and monotonic execution guard.
// This is a preset capability policy, not an alternate approval/runtime system.
export const name = 'weixin-capability-policy';
export const inject = ['tools'];
export const SAFE_TOOLS = new Set(['ask_user_question', 'self_model_read', 'self_model_propose', 'self_model_commit', 'self_model_history', 'self_model_rollback', 'memory_search', 'memory_trace', 'memory_history']);
export function apply(ctx) {
  ctx.tools.restrict({ allow: [] }); // Remove inherited host/MCP capabilities from this preset's schema.
  ctx.tools.guard(exec => SAFE_TOOLS.has(exec.name) ? undefined : '微信文本 Preset 未授权此工具');
}
