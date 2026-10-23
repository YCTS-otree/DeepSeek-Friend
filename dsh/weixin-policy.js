// DSH supplies both the registry restriction and monotonic execution guard.
// This is a preset capability policy, not an alternate approval/runtime system.
export const name = 'weixin-capability-policy';
export const inject = ['tools'];
export const SAFE_TOOLS = new Set(['ask_user_question', 'self_model_read', 'self_model_propose', 'self_model_commit', 'self_model_history', 'self_model_rollback', 'memory_search', 'memory_trace', 'memory_history', 'room_list', 'room_read', 'room_write', 'contact_list', 'contact_edit', 'contact_send_message', 'qq_send_message', 'weixin_contacts', 'weixin_send_message', 'weixin_send_sticker', 'sticker_list', 'sticker_note', 'alarm_set', 'alarm_list', 'alarm_cancel', 'private_note', 'take_rest']);
export function apply(ctx) {
  // Preset registrations belong to a standing parent scope in DSH 0.2.
  // Restrict on the concrete Agent: a parent allow:[] also hides our own tools.
  ctx.on('agent/created', ({ agent }) => {
    const allow = agent.ctx.tools.schemas(agent).map(t => t.name).filter(n => SAFE_TOOLS.has(n));
    agent.ctx.tools.restrict({ allow });
  });
  ctx.tools.guard(exec => SAFE_TOOLS.has(exec.name) ? undefined : '微信文本 Preset 未授权此工具');
}
