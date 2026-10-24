// Independent remote LLM transport. Credentials are handled only by DSF's existing loader.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
let input = '';
for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw Error('request-too-large'); }
const request = JSON.parse(input);
const root = path.resolve(process.argv[2]);
const { apiKeyEnvironment } = await import(pathToFileURL(path.join(root, 'scripts/runtime-options.js')));
try {
  const { env } = apiKeyEnvironment(root);
  if (!env.DEEPSEEK_API_KEY) throw Error('provider-credential-unavailable');
  if (!Array.isArray(request.messages) || request.messages.length > 256) throw Error('invalid-provider-messages');
  const body = { model: request.model || 'deepseek-flash', messages: request.messages, stream: false,
    max_tokens: request.max_tokens ?? 4096, thinking: { type: 'disabled' }, temperature: 0 };
  if (request.json !== false) body.response_format = { type: 'json_object' };
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(240000),
  });
  if (!response.ok) { console.log(JSON.stringify({ error: 'provider-http-' + response.status })); process.exitCode = 2; }
  else {
    const value = await response.json();
    const answer = value.choices?.[0];
    if (!answer || answer.finish_reason === 'length') throw Error('provider-output-truncated');
    console.log(JSON.stringify({ content: answer.message?.content, usage: value.usage, model: value.model, id: value.id, finish_reason: answer.finish_reason }));
  }
} catch (error) {
  const safe = ['provider-credential-unavailable', 'invalid-provider-messages', 'provider-output-truncated'].includes(error.message) ? error.message : 'provider-call-failed';
  console.log(JSON.stringify({ error: safe })); process.exitCode = 2;
}
