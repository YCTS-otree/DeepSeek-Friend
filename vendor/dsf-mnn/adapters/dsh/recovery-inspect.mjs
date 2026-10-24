import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const run = path.resolve(process.argv[2]);
const modules = path.resolve(process.argv[3], '@deepseek-ai');
const load = name => import(pathToFileURL(path.join(modules, name, 'lib/index.js')));
const { Context } = await load('cordis');
const { default: Persistence } = await load('dsh-session-persistence-jsonl');
const { Session, deriveEventMessage } = await load('dsh-session');
const ctx = new Context();
const persistence = new Persistence(ctx, { root: path.join(run, 'work/snapshot/dsh/sessions') });
const list = await persistence.list();
const directory = path.join(run, 'work/exported'); await fs.mkdir(directory, { recursive: true });
const rows = [];
for (const item of list) {
  const id = item.header?.id ?? item.meta?.id ?? item.id;
  if (!id) throw Error('persistence-list-header-unknown');
  const handle = await persistence.open(id, 'read');
  try {
    const { events } = await handle.read();
    const session = Session.create(id, events, handle.header, handle.inheritedEventCount);
    const counts = {};
    for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
    const attempts = events.filter(e => e.type === 'turn/end' && e.data.reason?.kind === 'error');
    const usage = events.filter(e => e.type === 'assistant/message').map(e => e.data.usage).filter(Boolean);
    const file = createHash('sha256').update(id).digest('hex').slice(0, 16) + '.json';
    const body = { schema: 'dsf-mnn-dsh-export/1', session_id: id, header: handle.header, inherited_event_count: handle.inheritedEventCount,
      events, surface: [...session.surface.nodes], messages: session.deriveMessages(),
      projected: session.surface.nodes.map(seq => ({ seq, message: session.deriveEventMessage(events[seq]) })) };
    await fs.writeFile(path.join(directory, file), JSON.stringify(body), { flag: 'wx' });
    rows.push({ id, export_file: file, events: events.length, surface_nodes: body.surface.length, message_bytes: Buffer.byteLength(JSON.stringify(body.messages)),
      counts, failures: attempts.map(e => ({ seq: e.seq, code: e.data.reason.error?.code, message_length: String(e.data.reason.error?.message || '').length })), last_usage: usage.at(-1) });
  } finally { await handle.close(); }
}
await fs.writeFile(path.join(run, 'work/sessions-index.json'), JSON.stringify(rows, null, 2), { flag: 'wx' });
console.log(JSON.stringify(rows));
