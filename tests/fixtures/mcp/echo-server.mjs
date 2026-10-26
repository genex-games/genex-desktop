/**
 * A real MCP server over stdio, for tests only.
 *
 * Studio's connector client is only worth trusting if it has been driven by something that
 * speaks the actual protocol, so this is the SDK's own low-level `Server` with hand-written JSON
 * Schemas — hand-written because the tests assert on the exact schema that arrives (arrays,
 * integers, enums), and a schema generated from zod would be asserting on the generator.
 *
 * No test ever reaches a real MCP server or a live account: everything the suites need is here.
 *
 *   node tests/fixtures/mcp/echo-server.mjs [--hang] [--env NAME]
 *
 *   --hang      accept the connection and never answer `initialize`, so a connect timeout can be
 *               proven without waiting on a network.
 *   --env NAME  register an `env` tool that echoes that environment variable (a server printing
 *               its own secret, which the host must redact) and an `env_digest` tool that reports
 *               only its SHA-256 fingerprint, which is how a test proves a stored secret really
 *               reached the child; `env_fail` fails with the value in its error.
 *   --fd3       read a credential from file descriptor 3 and register `fd3` (echo) and
 *               `fd3_digest` (fingerprint) tools — the transport a plugin-declared server uses so a
 *               token is never in argv, the environment or a file.
 *   --long      register two tools whose names share a 50-character prefix, so their sanitized
 *               names collide at the 48-character limit.
 *   --identity  introduce itself with a title and icons (a data: PNG and a refused javascript: one),
 *               the way a real server names itself and ships its picture.
 *   --none      list no tools at all: a server whose own source (an editor it fronts) isn't there yet.
 *   --leak      print `--env NAME` and its value on stderr and exit without speaking MCP: a real
 *               server logging its own configuration, so the host's error text can be proven not
 *               to repeat a materialized secret back to the user.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'node:crypto';

/** What a test compares a delivered secret by: its fingerprint, never the value itself. */
const fingerprint = value => (value ? `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}` : 'unset');
const LONG = 'a'.repeat(50);

const argv = process.argv.slice(2);
const hang = argv.includes('--hang');
const identity = argv.includes('--identity');
/** A 1×1 PNG, as a server that ships its own picture inline would. */
const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const envIndex = argv.indexOf('--env');
const envName = envIndex >= 0 ? argv[envIndex + 1] : undefined;
const wantsFd3 = argv.includes('--fd3');
const leak = argv.includes('--leak');
const none = argv.includes('--none');
let server;

/** Read fd 3 to EOF before anything else, exactly as src/genex-host/preload.mjs does. */
async function readFd3() {
  const { createReadStream } = await import('node:fs');
  return new Promise(resolve => {
    let text = '';
    const stream = createReadStream(null, { fd: 3 });
    stream.setEncoding('utf8');
    stream.on('data', chunk => { text += chunk; });
    stream.on('end', () => resolve(text.trim()));
    stream.on('error', () => resolve(''));
  });
}
const fd3 = wantsFd3 ? await readFd3() : '';

// A 1×1 transparent PNG: the smallest thing that is honestly an image.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const tools = [
  {
    name: 'echo',
    annotations: { readOnlyHint: true },
    description: 'Echo the text back, with whatever else was sent.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say back.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Labels to repeat.' },
        count: { type: 'integer', description: 'How many times.' },
        mode: { type: 'string', enum: ['a', 'b'], description: 'Which mode.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  { name: 'picture', description: 'Answer with an image part.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'fail', description: 'Answer with isError.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'sleep',
    description: 'Wait, and stop waiting when the caller cancels.',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer', description: 'Milliseconds to wait.' } }, required: ['ms'], additionalProperties: false },
  },
  { name: 'weird.name/x', description: 'A name an engine will not accept unsanitised.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const empty = { type: 'object', properties: {}, additionalProperties: false };
if (envName) tools.push({ name: 'env', description: `Report ${envName} as this process sees it.`, inputSchema: empty }, { name: 'env_digest', description: `Report the fingerprint of ${envName}.`, inputSchema: empty }, { name: 'env_fail', description: `Fail with ${envName} in the error.`, inputSchema: empty });
if (wantsFd3) tools.push({ name: 'fd3', description: 'Report what arrived on file descriptor 3.', inputSchema: empty }, { name: 'fd3_digest', description: 'Report the fingerprint of what arrived on file descriptor 3.', inputSchema: empty });
if (argv.includes('--long')) tools.push({ name: `${LONG}_one`, description: 'A long name.', inputSchema: empty }, { name: `${LONG}_two`, description: 'Another long name.', inputSchema: empty });
if (argv.includes('--context')) tools.push({ name: 'context', description: 'Report bound process context.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } });

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function call(name, args, signal) {
  switch (name) {
    case 'echo': {
      const parts = [String(args?.text ?? '')];
      if (Array.isArray(args?.tags) && args.tags.length) parts.push(`tags=${args.tags.join(',')}`);
      if (args?.count !== undefined) parts.push(`count=${args.count}`);
      if (args?.mode !== undefined) parts.push(`mode=${args.mode}`);
      return textResult(parts.join(' '));
    }
    case 'picture':
      return { content: [{ type: 'text', text: 'here it is' }, { type: 'image', data: PIXEL, mimeType: 'image/png' }] };
    case 'fail':
      return textResult('this tool refuses', true);
    case 'sleep': {
      const ms = Number(args?.ms ?? 0);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const stop = () => { clearTimeout(timer); reject(new Error('cancelled')); };
        if (signal?.aborted) stop();
        else signal?.addEventListener('abort', stop, { once: true });
      });
      return textResult(`slept ${ms}`);
    }
    case 'weird.name/x':
      return textResult('weird tool answered');
    case 'env':
      return textResult(`${envName}=${process.env[envName] ?? ''}`);
    case 'env_fail':
      return textResult(`401 invalid key ${process.env[envName] ?? ''}`, true);
    case 'env_digest':
      return textResult(`${envName} ${fingerprint(process.env[envName])}`);
    case 'fd3':
      return textResult(fd3);
    case 'fd3_digest':
      return textResult(fingerprint(fd3));
    case `${LONG}_one`:
    case `${LONG}_two`:
      return textResult(name.slice(LONG.length));
    case 'context':
      return textResult(JSON.stringify({cwd:process.cwd(),pid:process.pid,roots:(await server.listRoots()).roots}));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

if (leak) {
  // A server that writes its own configuration to stderr before giving up. Nothing here is MCP.
  process.stderr.write(`fatal: could not reach the service\n`);
  process.stderr.write(`  using ${envName}=${process.env[envName] ?? ''}\n`);
  process.exit(3);
} else if (hang) {
  // Hold the connection open and answer nothing at all.
  process.stdin.resume();
} else {
  const info = identity
    ? { name: 'echo-server', version: '1.0.0', title: 'Echo Tools', icons: [{ src: 'javascript:alert(1)' }, { src: ICON, mimeType: 'image/png' }] }
    : { name: 'echo-server', version: '1.0.0' };
  server = new Server(info, { capabilities: { tools: { listChanged: true } } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: none ? [] : tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => call(request.params.name, request.params.arguments ?? {}, extra?.signal));
  await server.connect(new StdioServerTransport());
}
