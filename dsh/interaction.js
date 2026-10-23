import { RuntimeStore } from '../src/runtime.js';
import { clean } from '../src/cognitive/store.js';
import { defineTool } from '../.runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { createUserMessage } from '../.runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
export const INTERACTION_TOOLS = ['weixin_contacts', 'weixin_send_message', 'weixin_send_sticker', 'sticker_list', 'sticker_note', 'alarm_set', 'alarm_list', 'alarm_cancel', 'take_rest'];
export function installInteraction(ctx, runtime) {
  ctx.systemPrompt.section({ name: 'friend:clock', order: 22010, interpolate: false, text: () => '当前时间：' + new Date().toISOString() + '；本地时区 Asia/Shanghai。' });
  ctx.systemPrompt.section({ name: 'friend:interaction', order: 22000, interpolate: false, text:
    '你可以持续思考，不要求每次产生对外内容。发给微信的话必须调用 weixin_send_message，可以在同一轮多次调用；其他正文是私有笔记，不自动发给任何人。原生 reasoning 也只保存到本机。不要把内部思考作为消息发送。排队不等于送达，不要为了重试不明结果而重复调用发送工具。可以用 weixin_send_sticker 发送已收到的图片，用 sticker_note 留下自己对表情含义的理解（推断而非事实）。你有一个小闹钟：alarm_set 设置未来的带时区时间，不要求原因，note 可省略；OTREE 已明确允许你自主决定何时主动发消息，这是你的自由；闹钟响后也可以联系已知联系人。用 weixin_contacts 选择联系人，只使用官方有效会话凭据；测试不发送微信。想暂时休息就调用 take_rest，不要求解释。新消息或闹钟会再次叫醒你。单次输出达到长度限制可以继续下一步，持续运行没有累计 token 或步数截止。' });
  ctx.on('agent/request', async (p, next) => {
    const c = await next(), s = runtime.settings();
    return { ...c, provider: s.provider, model: s.model, reasoningEffort: s.reasoningEffort, maxTokens: s.maxTokens };
  });
  ctx.on('agent/pre-step', async (p, next) => {
    const c = runtime.context(p.agent?.id);
    if (c && runtime.settings().paused) return { kind: 'reject' };
    const decision = await next();
    const session = p.agent?.session, history = session?.toolHistory?.();
    // DSH's addition-only projection defers every tool added after an empty baseline.
    // DeepSeek requires an eager tool. Rebase declarations through the native boundary;
    // the Session, messages, permissions and raw historical events remain intact.
    if (decision.kind === 'enter' && session?.requestHeader?.() && history) {
      const active = ctx.tools.schemas(p.agent), names = new Set(active.map(tool => tool.name));
      const eager = history.tools.some(tool => tool.deferLoading !== true && names.has(tool.name));
      if (!eager && active.some(tool => tool.deferLoading !== true)) return { ...decision, startsRequestSeries: true };
    }
    return decision;
  });
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const c = runtime.context(agent?.id), s = runtime.settings();
    if (!c || c.rest || c.preempt || !s.continuous || s.paused || signal.aborted) return;
    if (s.continueDelayMs) await new Promise(resolve => { const timer = setTimeout(finish, s.continueDelayMs); function finish() { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); } signal.addEventListener('abort', finish, { once: true }); });
    const latest = runtime.context(agent.id);
    if (signal.aborted || latest?.rest || latest?.preempt || !runtime.settings().continuous || runtime.settings().paused) return;
    agent.inject(createUserMessage({ source: { kind: 'friend-continuation' }, content: [{ type: 'text', text: '可以继续思考或使用已有授权工具，不必对外输出；发言使用消息工具，想休息可调用 take_rest。' }] }));
  });
  ctx.on('session/event', (session, event) => runtime.record(session.id, event));
  const definitions = {
    weixin_contacts: { parameters: {}, call: (_a, e) => runtime.context(e.agent.id)?.kind === 'test' ? [] : runtime.contacts(), description: '查看已授权、已有官方会话凭据的联系人及 recipient ID；测试空间不列出真实联系人。' },
    weixin_send_message: { parameters: { text: { type: 'string', required: true }, recipient: { type: 'string', description: 'weixin_contacts 的 ID；省略时选择当前消息发送者，闹钟中选最近联系人。' } }, call: (a, e) => runtime.emit(e.agent.id, e.callId, a.text, null, a.recipient), description: '可以自由决定主动发消息，也可单轮多次发送；仅支持已有官方会话凭据的已授权联系人。测试仅记录。返回排队状态，不冒称送达。' },
    weixin_send_sticker: { parameters: { id: { type: 'string', required: true }, recipient: { type: 'string' } }, call: (a, e) => runtime.emit(e.agent.id, e.callId, '', a.id, a.recipient), description: '把已接收并保存在本机库里的图片作为单独图片消息发送；微信原生商店表情协议不在此接口范围。' },
    sticker_list: { parameters: {}, call: (_a, e) => runtime.context(e.agent.id)?.kind === 'test' ? [] : runtime.db.prepare('SELECT id,media_type,bytes,note,created FROM images ORDER BY created DESC LIMIT 60').all(), description: '查看本机收到的图片/表情库；note 是自己的解释，可随经历修正。测试不访问正式图片库。' },
    sticker_note: { parameters: { id: { type: 'string', required: true }, note: { type: 'string', required: true } }, call: (a, e) => { if (runtime.context(e.agent.id)?.kind === 'test') throw Error('test-image-library-isolated'); if (typeof a.note !== 'string' || a.note.length > 1000 || clean(a.note, 1000) !== a.note) throw Error('sticker-note-invalid'); return { changed: runtime.db.prepare('UPDATE images SET note=? WHERE id=?').run(a.note, a.id).changes }; }, description: '根据实际看到的图片记录表情含义和用法，不把猜测当作已证实事实。' },
    alarm_set: { parameters: { at: { type: 'string', required: true, description: '包含时区的 ISO 8601 时间。' }, note: { type: 'string' } }, call: (a, e) => runtime.alarm(e.agent.id, e.callId, a.at, a.note), description: '给自己设置一次持久小闹钟；不要求原因或备注，支持重启补执行。' },
    alarm_list: { parameters: {}, call: (_a, e) => runtime.alarms(e.agent.id), description: '查看自己的闹钟与执行状态。' },
    alarm_cancel: { parameters: { id: { type: 'string', required: true } }, call: (a, e) => runtime.cancelAlarm(e.agent.id, a.id), description: '取消尚未响起的自己的闹钟。' },
    take_rest: { parameters: {}, call: (_a, e) => { runtime.flag(e.agent.id, 'rest'); e.concludeTurn(); return { resting: true }; }, description: '暂时休息，无需理由；不会清空上下文，新消息或闹钟可再次唤醒。' },
  };
  for (const [name, spec] of Object.entries(definitions)) ctx.tools.register(defineTool({ name, description: spec.description, parameters: spec.parameters,
    output: { schema: { type: 'json' }, render: (_a, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (a, e) => { if (!runtime.context(e.agent?.id)) throw Error('interaction-session-unbound'); return spec.call(a, e); } }));
}
export function mountInteraction(ctx, dir) { const runtime = new RuntimeStore(dir); ctx.effect(() => () => runtime.close()); installInteraction(ctx, runtime); }
