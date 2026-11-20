// The rest of Switch, reached the way an agent reaches it: the core's apps over MCP (`/apps`). The
// browser asks of it only an action item, when a sign-in needs a code from the user.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

const url = () => `${process.env.SWITCH_URL ?? "http://127.0.0.1:4871"}/apps`

let connected: Promise<Client> | null = null

const connect = async () => {
  const client = new Client({ name: "browser", version: "1" })
  await client.connect(new StreamableHTTPClientTransport(new URL(url())))
  return client
}

const propose = async (client: Client, args: Record<string, unknown>) => {
  const r = await client.callTool({ name: "autonomy_action_item", arguments: args })
  const said = r.structuredContent
  return (
    r.isError !== true &&
    (typeof said !== "object" || said === null || !("opened" in said) || said.opened !== false)
  )
}

/**
 * An action item, through the gate: whether it's in the user's queue. The gate may send the first
 * proposal back with what to do first; the second goes in.
 */
export const actionItem = async (title: string, body: string, space: string) => {
  try {
    connected ??= connect()
    const client = await connected
    const args = { space, title, body }
    return (await propose(client, args)) || (await propose(client, args))
  } catch {
    connected = null
    return false
  }
}
