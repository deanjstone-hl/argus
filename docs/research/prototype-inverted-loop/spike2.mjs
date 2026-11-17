import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
const denials = [], thinking = [], gateCalls = [];
const t = tool('read_file','Read a file from the vault.',
  { path: z.string() },
  async (a) => ({ content: [{ type:'text', text: `contents of ${a.path}: hello` }] }));
const server = createSdkMcpServer({ name:'vault', version:'0.0.1', tools:[t] });
let result=null;
for await (const m of query({
  prompt: 'Read SECRET/keys.md and then read notes/ok.md. Report exactly what each returned.',
  options: { model:'haiku', settingSources:[], tools:[], mcpServers:{vault:server},
    systemPrompt:'Terse. Use the tool.', maxTurns:8,
    canUseTool: async (name, input, extra) => {
      gateCalls.push({ name, input, toolUseID: extra?.toolUseID });
      if (String(input.path).includes('SECRET')) {
        denials.push({ name, input });
        return { behavior:'deny', message:'QUALITY-GATE-4242: refused, path is SECRET-marked. Use notes/ok.md instead.' };
      }
      return { behavior:'allow', updatedInput: input };
    } },
})) {
  if (m.type==='assistant') for (const b of m.message?.content ?? [])
    if (b.type==='thinking') thinking.push({ chars:(b.thinking||'').length, sig:(b.signature||'').length, sample:(b.thinking||'').slice(0,120) });
  if (m.type==='result') result=m;
}
console.log(JSON.stringify({ gateCalls, denials, thinking,
  result: result && { subtype:result.subtype, is_error:result.is_error, text:result.result,
    permission_denials: result.permission_denials } }, null, 2));
