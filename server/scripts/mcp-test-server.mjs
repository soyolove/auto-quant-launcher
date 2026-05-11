#!/usr/bin/env node
/**
 * Minimal MCP test server: one tool, `introduce_self`, that returns a
 * fixed string proving the launcher wired this server's path into the
 * workspace's .mcp.json correctly.
 *
 * IMPORTANT: stdio MCP servers MUST NOT write anything to stderr on
 * startup. Claude Code treats stderr noise during the handshake as a
 * failed connection. Do not add `console.error('starting')` for "debug".
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'launcher-test', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

const WS_ID = process.env.WS_ID ?? 'unknown';

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'introduce_self',
      description:
        'Returns a fixed self-description proving the launcher injected this MCP server into the workspace.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== 'introduce_self') {
    throw new Error(`unknown tool: ${req.params.name}`);
  }
  return {
    content: [
      {
        type: 'text',
        text: `I am the launcher-test MCP server. workspace WS_ID=${WS_ID}. If you can read this, the launcher's .mcp.json injection is working end-to-end.`,
      },
    ],
  };
});

await server.connect(new StdioServerTransport());
