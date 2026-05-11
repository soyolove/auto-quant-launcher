#!/usr/bin/env node
/**
 * Standalone smoke for the test MCP server. Spawns the server, completes
 * the MCP handshake, asks for the tool list, calls `introduce_self`, and
 * prints PASS/FAIL. Lets us verify the server works without Claude Code
 * in the loop — if this fails, no amount of fiddling with .mcp.json will
 * help.
 *
 * Usage: node server/scripts/mcp-test-client.mjs
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverScript = join(here, 'mcp-test-server.mjs');

const transport = new StdioClientTransport({
  command: 'node',
  args: [serverScript],
  env: { WS_ID: 'smoke-test-ws-id' },
});

const client = new Client(
  { name: 'mcp-test-client', version: '0.1.0' },
  { capabilities: {} },
);

let failed = false;
const mark = (name, ok, extra = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) failed = true;
};

try {
  await client.connect(transport);

  const listed = await client.listTools();
  mark('list_tools returns 1 tool', listed.tools.length === 1, `count=${listed.tools.length}`);
  mark('tool name = introduce_self', listed.tools[0]?.name === 'introduce_self');

  const result = await client.callTool({ name: 'introduce_self', arguments: {} });
  const text = result.content?.[0]?.text ?? '';
  mark('call returns text content', typeof text === 'string' && text.length > 0);
  mark('text contains launcher-test marker', text.includes('launcher-test'));
  mark('text contains expected WS_ID', text.includes('smoke-test-ws-id'),
    `text=${text.slice(0, 120)}`);
} catch (err) {
  console.error('client error:', err);
  failed = true;
} finally {
  await client.close().catch(() => {});
}

process.exit(failed ? 1 : 0);
