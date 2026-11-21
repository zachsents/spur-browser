// The Chrome extension, as this process reaches it. Chrome (or another Chromium browser) starts the
// relay (relay.ts) as the Chrome extension's native messaging host; the relay says which browser
// started it and passes the browser's messages to this process over a local socket. The extension
// answers the hands' calls (`call`) and sends what its tabs' debugger sessions report (`events`).
// Ported from Switchboard's chrome.rs.
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createServer } from "node:net"
import type { Socket } from "node:net"

/** Where this keeps what Chrome loads: the Chrome extension, the relay and the socket. */
export const HOME = process.env.SWITCH_BROWSER_HOME ?? path.join(homedir(), ".switch", "browser")
export const SOCKET = path.join(HOME, "chrome.sock")
export const EXTENSION = path.join(HOME, "extension")
const HOST = "ax.switch.browser"
const SOURCE = path.join(import.meta.dir, "..", "extension")
const FILES = ["manifest.json", "background.js", "hands.js"] as const
const EXTENSION_ID = readFileSync(path.join(SOURCE, "ID"), "utf-8").trim()

export type Json = Record<string, unknown>
export const isJson = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : "")

/** A browser the extension can run in: its app's name, bundle id and user data folder. */
interface Chromium {
  readonly name: string
  readonly bundle: string
  readonly data: string
}

export const CHROMIUM: readonly Chromium[] = [
  { name: "Google Chrome", bundle: "com.google.Chrome", data: "Google/Chrome" },
  { name: "Google Chrome Beta", bundle: "com.google.Chrome.beta", data: "Google/Chrome Beta" },
  {
    name: "Google Chrome Canary",
    bundle: "com.google.Chrome.canary",
    data: "Google/Chrome Canary",
  },
  { name: "Chromium", bundle: "org.chromium.Chromium", data: "Chromium" },
  { name: "Microsoft Edge", bundle: "com.microsoft.edgemac", data: "Microsoft Edge" },
  { name: "Brave Browser", bundle: "com.brave.Browser", data: "BraveSoftware/Brave-Browser" },
  { name: "Vivaldi", bundle: "com.vivaldi.Vivaldi", data: "Vivaldi" },
  { name: "Arc", bundle: "company.thebrowser.Browser", data: "Arc/User Data" },
]

/** The browsers on this Mac that can run the extension. */
const installed = () =>
  CHROMIUM.filter((b) =>
    ["/Applications", path.join(homedir(), "Applications")].some((dir) =>
      existsSync(path.join(dir, `${b.name}.app`)),
    ),
  )

/** The extension's files, stamped with a hash of them as `version_name`. */
const files = () => {
  const read = FILES.map((name) => readFileSync(path.join(SOURCE, name), "utf-8"))
  const version = createHash("sha256").update(read.join("\0")).digest("hex").slice(0, 16)
  const [manifest = "", ...rest] = read
  const stamped = manifest.replace("{", `{\n  "version_name": "${version}",`)
  return { version, contents: [stamped, ...rest] }
}

const { version, contents } = files()

/**
 * Writes the extension where a browser loads it unpacked, and the relay, and registers the relay
 * as its native messaging host with every browser here that can run it. A loaded extension older
 * than these files reloads itself once it says hello. Returns the browsers it registered with.
 */
export const install = () => {
  mkdirSync(EXTENSION, { recursive: true })
  for (const [i, name] of FILES.entries()) {
    const file = path.join(EXTENSION, name)
    const text = contents[i] ?? ""
    if (!existsSync(file) || readFileSync(file, "utf-8") !== text) {
      writeFileSync(file, text)
    }
  }
  const relay = path.join(HOME, "relay")
  // The binary running this may be a host compiled with bun, which is bun again with BUN_BE_BUN set.
  const script = `#!/bin/sh\nBUN_BE_BUN=1 exec "${process.execPath}" "${path.join(import.meta.dir, "relay.ts")}" "$@"\n`
  if (!existsSync(relay) || readFileSync(relay, "utf-8") !== script) {
    writeFileSync(relay, script, { mode: 0o755 })
  }
  const host = {
    name: HOST,
    description: "Switch's browser extension",
    path: relay,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  }
  const browsers = installed()
  for (const b of browsers) {
    const dir = path.join(homedir(), "Library/Application Support", b.data, "NativeMessagingHosts")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${HOST}.json`), `${JSON.stringify(host, null, 2)}\n`)
  }
  return browsers
}

/** The browser a relay said started it. */
export interface Browser {
  readonly name: string
  readonly bundle: string
  /** The browser's own process: the copy to drive natively when several run. */
  readonly pid: number | null
}

interface Link {
  readonly socket: Socket
  browser: Browser | null
  /** The release its extension said it is, once it says hello. */
  release: string | null
  rest: string
}

type Listener = (session: string, method: string, params: Json) => void

/** The page in front, as the extension last said. */
export interface Page {
  readonly url: string
  readonly title: string
  /** An agent is driving it, so it being in front isn't the user looking at it. */
  readonly agent: boolean
  /** None of the browser's windows the extension can see is in front. */
  readonly hidden: boolean
}

const pageListeners: ((page: Page) => void)[] = []

/** Follows the page in front. */
export const onPage = (listener: (page: Page) => void) => {
  pageListeners.push(listener)
}

const links: Link[] = []
const waiting = new Map<string, (reply: Json) => void>()
const listeners: Listener[] = []
let hello: (() => void)[] = []

const newest = () => links.at(-1)

/** Whether the extension is connected now. */
export const connected = () => links.length > 0

/** Whether the newest connection's extension has said hello, so it has hands. */
export const hasHands = () => typeof newest()?.release === "string"

/** The browser the newest connection is in: where the hands are. */
export const browser = () => newest()?.browser ?? null

/** Follows what the extension's debugger sessions report. */
export const onEvent = (listener: Listener) => {
  listeners.push(listener)
}

const send = (link: Link, message: Json) => {
  link.socket.write(`${JSON.stringify(message)}\n`)
}

const heard = (link: Link, message: Json) => {
  const type = str(message.type)
  if (type === "browser") {
    const pid = typeof message.pid === "number" ? message.pid : null
    link.browser = { name: str(message.name), bundle: str(message.bundle), pid }
  } else if (type === "page") {
    const page: Page = {
      url: str(message.url),
      title: str(message.title),
      agent: message.agent === true,
      hidden: message.hidden === true,
    }
    for (const listener of pageListeners) {
      listener(page)
    }
  } else if (type === "reply") {
    const id = str(message.id)
    waiting.get(id)?.(message)
    waiting.delete(id)
  } else if (type === "event") {
    const params = isJson(message.params) ? message.params : {}
    for (const listener of listeners) {
      listener(str(message.session), str(message.method), params)
    }
  } else if (type === "hello") {
    link.release = str(message.release)
    // An extension older than the files just written reloads itself from them.
    if (message.version !== version) {
      send(link, { type: "reload" })
    }
    const woken = hello
    hello = []
    for (const wake of woken) {
      wake()
    }
  }
}

/** Takes relays' connections for as long as the extension runs. */
export const serve = () => {
  mkdirSync(HOME, { recursive: true })
  rmSync(SOCKET, { force: true })
  const server = createServer((socket) => {
    const link: Link = { socket, browser: null, release: null, rest: "" }
    links.push(link)
    socket.setEncoding("utf-8")
    socket.on("data", (data: string) => {
      const all = (link.rest + data).split("\n")
      link.rest = all.pop() ?? ""
      for (const line of all) {
        try {
          const message: unknown = JSON.parse(line)
          if (isJson(message)) {
            heard(link, message)
          }
        } catch {
          // A torn line: skipped.
        }
      }
    })
    const gone = () => {
      const at = links.indexOf(link)
      if (at !== -1) {
        links.splice(at, 1)
      }
    }
    socket.on("close", gone)
    socket.on("error", gone)
  })
  server.listen(SOCKET)
}

/** Runs one of the extension's hands (`open`, `cdp`, `tabs`…) and returns what it gave back. */
export const call = async (method: string, params: Json, ms = 30_000): Promise<unknown> => {
  const link = newest()
  if (!link) {
    throw new Error("The Switch extension isn't connected in a browser on this Mac")
  }
  const id = randomUUID()
  const answered = Promise.withResolvers<Json | null>()
  const timer = setTimeout(() => {
    waiting.delete(id)
    answered.resolve(null)
  }, ms)
  waiting.set(id, (r) => {
    clearTimeout(timer)
    answered.resolve(r)
  })
  send(link, { type: "call", id, method, params })
  const reply = await answered.promise
  if (reply === null) {
    throw new Error(`The browser didn't answer within ${ms / 1000}s`)
  }
  if (typeof reply.error === "string") {
    throw new TypeError(reply.error)
  }
  return reply.result ?? null
}

const running = async (name: string) => (await Bun.spawn(["pgrep", "-x", name]).exited) === 0

/**
 * Makes sure the extension is there to drive a browser: when no browser that can run it is up, the
 * first one here is started in the background, and the extension connects as it comes up.
 */
export const reach = async () => {
  if (hasHands()) {
    return
  }
  const here = installed()
  const [first] = here
  if (!first) {
    throw new Error("No browser on this Mac can run the Switch extension")
  }
  const up = await Promise.all(here.map(async (b) => await running(b.name)))
  if (!up.some(Boolean) && !connected()) {
    await Bun.spawn(["open", "-g", "-b", first.bundle]).exited
  }
  // Up to 20 s for the browser to come up and connect; a connected extension says hello at once.
  const said = Promise.withResolvers<null>()
  hello.push(() => {
    said.resolve(null)
  })
  await Promise.race([said.promise, Bun.sleep(20_000)])
  if (hasHands()) {
    return
  }
  throw new Error(
    connected()
      ? "The Switch extension is connected but hasn't said hello: reload it in chrome://extensions"
      : `The Switch extension isn't loaded in ${first.name}: in chrome://extensions, Developer mode on, Load unpacked, ${EXTENSION}`,
  )
}
