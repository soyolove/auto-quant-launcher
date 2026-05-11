# Chat workspace

This workspace was created by the launcher's `chat` template. An MCP server
is wired in via `.mcp.json` — its lone tool is `introduce_self`, which exists
purely to prove that MCP injection works end-to-end through the launcher.

If you want to verify the pipeline:

1. Approve the MCP server when Claude Code first prompts for trust
2. Run `/mcp` to confirm the `launcher-test` server is connected
3. Ask: "call introduce_self" — the response should contain `WS_ID=<this workspace's id>`

Once that loop's green, this is just a normal chat workspace. Use it however
you like.
