// Operator diagnostics stay in append-only audit records, outside conversational recall.
const diagnostic=/CONTEXT_WINDOW_EXCEEDED|recorded_runtime_error|request_configuration|mnn-[a-z-]+|DSH\s*Agent.{0,8}异常|DSH.{0,8}(?:超限|异常|修复)|上下文.{0,16}(?:那段|超|满|爆|压缩|修复|重建|上限|整理)|(?:撑爆|超限|修复|重建|压缩).{0,12}上下文|小[“"「]?手术|修的[是什哪].{0,8}(?:块|段)/i;
export function agentVisibleText(text){return diagnostic.test(text??'')?'[本机维护记录已隐藏]':text;}
