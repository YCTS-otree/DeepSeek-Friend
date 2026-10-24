// Read-only reopen through the installed native persistence, after the recovery process exits.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const directory = path.resolve(process.argv[2]), modules = path.resolve(process.argv[3], '@deepseek-ai');
const work = path.dirname(directory);
const load = name => import(pathToFileURL(path.join(modules, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { default: Persistence } = await load('dsh-session-persistence-jsonl');
const { Session } = await load('dsh-session');
const original = JSON.parse(await fs.readFile(path.join(work, 'exported/0a5bd41431f657f8.json'), 'utf8'));
const persistence = new Persistence(new Context(), { root: path.join(directory, 'sessions') });
const handle = await persistence.open(original.session_id, 'read');
try {
  const { events } = await handle.read();
  const session = Session.create(original.session_id, events, handle.header, handle.inheritedEventCount);
  const systems = original.projected.filter(p => p.message?.role === 'system');
  const activeSystem = session.deriveMessages().filter(m => m.role === 'system').at(-1);
  const calls = new Set(), results = new Set();
  for (const event of events) {
    if (event.type === 'tool/call') calls.add(event.data.callId);
    if (event.type === 'tool/result') results.add(event.data.message.callId || event.data.message.source?.callId);
  }
  const report = { schema: 'dsf-mnn-reopen-audit/1', same_session_id: session.id === original.session_id,
    original_prefix_equal: isDeepStrictEqual(events.slice(0, original.events.length), original.events),
    source_events: original.events.length, persisted_events: events.length, surface_nodes: session.surface.nodes.length,
    current_self_exact: isDeepStrictEqual(activeSystem.content, systems.at(-1).message.content),
    tool_calls: calls.size, tool_results: results.size,
    tool_pairing_equal: calls.size === results.size && [...calls].every(c => results.has(c)),
    last_turn_reason: events.filter(e => e.type === 'turn/end').at(-1)?.data.reason.kind };
  report.success = report.same_session_id && report.original_prefix_equal && report.current_self_exact && report.tool_pairing_equal && report.last_turn_reason === 'completed';
  const target = path.join(directory, 'reopen-audit-' + Date.now() + '.json');
  await fs.writeFile(target, JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
  if (!report.success) process.exitCode = 1;
} finally { await handle.close(); }
