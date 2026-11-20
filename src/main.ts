// The browser spur: Agent Quick Browse's MCP server as it is, on stdio. It drives this machine's
// Chrome through AQB's extension; its decision model's key comes from the environment or ~/.aqb/env.
const entry = Bun.fileURLToPath(import.meta.resolve("agent-quick-browse/src/index.ts"))
const proc = Bun.spawn([process.execPath, entry, "mcp"], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})
process.exitCode = await proc.exited
