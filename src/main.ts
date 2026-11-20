// The browser spur: Agent Quick Browse's MCP server as it is, on stdio, with one tool of its own
// in front: `browser_js`, an expression evaluated in a session's tab (through the same Chrome
// connection AQB's tools use), for pages a spur reads by script. Every other message passes
// through unchanged. Its decision model's key comes from the environment or ~/.aqb/env.
import { evaluateExpression, withSession } from "agent-quick-browse/src/tab.ts"

type Json = Record<string, unknown>
const isJson = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : "")

const JS = {
  name: "browser_js",
  description:
    "Evaluate a JavaScript expression in the session's tab and return its JSON value (promises are awaited). The tab keeps its page; navigate first with browser_navigate.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "An expression; wrap statements in an IIFE." },
      session: { type: "string", description: "The agent tab to use (default: this spur's)." },
      group: { type: "string", description: "The session tab's group." },
    },
    required: ["code"],
  },
  annotations: { readOnlyHint: false, openWorldHint: true },
}

const parse = (line: string): Json | null => {
  try {
    const m: unknown = JSON.parse(line)
    return isJson(m) ? m : null
  } catch {
    return null
  }
}

const write = (m: Json) => {
  process.stdout.write(`${JSON.stringify(m)}\n`)
}

const entry = Bun.fileURLToPath(import.meta.resolve("agent-quick-browse/src/index.ts"))
const aqb = Bun.spawn([process.execPath, entry, "mcp"], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
})

/** Ids of tools/list requests, whose answers gain browser_js. */
const listing = new Set<unknown>()

const runJs = async (id: unknown, args: Json) => {
  const session = str(args.session) || "spur-browser"
  const group = str(args.group)
  try {
    const value: unknown = await withSession(
      session,
      async () => await evaluateExpression(str(args.code)),
      group === "" ? {} : { group },
    )
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null)
    write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } })
  }
}

const fromClient = (line: string) => {
  const m = parse(line)
  if (m?.method === "tools/list") {
    listing.add(m.id)
  }
  if (m?.method === "tools/call" && isJson(m.params) && m.params.name === JS.name) {
    void runJs(m.id, isJson(m.params.arguments) ? m.params.arguments : {})
    return
  }
  void aqb.stdin.write(`${line}\n`)
}

const fromAqb = (line: string) => {
  const m = parse(line)
  if (m !== null && m.method === undefined && listing.has(m.id) && isJson(m.result)) {
    listing.delete(m.id)
    const listed: unknown = m.result.tools
    const tools: readonly unknown[] = Array.isArray(listed) ? listed : []
    write({ ...m, result: { ...m.result, tools: [...tools, JS] } })
    return
  }
  process.stdout.write(`${line}\n`)
}

const lines = async (stream: ReadableStream<Uint8Array>, each: (line: string) => void) => {
  const decoder = new TextDecoder()
  let rest = ""
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true })
    const all = rest.split("\n")
    rest = all.pop() ?? ""
    for (const line of all) {
      if (line.trim() !== "") {
        each(line)
      }
    }
  }
}

void lines(aqb.stdout, fromAqb)
await lines(Bun.stdin.stream(), fromClient)
aqb.kill()
process.exitCode = await aqb.exited
