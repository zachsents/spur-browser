// The user's secrets this Mac keeps for forms: card numbers and codes, identity and bank numbers.
// `fill_secret` puts one straight into a field, reading it from the Keychain for that one use; the
// `secret` tool lists them, keeps a card the browser has saved (it fills it into a form of the
// spur's own), and forgets them. Nothing says what a secret is: a fill is reported by how many
// characters the field then holds, and the field is sealed after it, so nothing reads it back and
// screenshots show dots. Ported from Switchboard's secrets.rs and secret.rs, whose secrets it takes
// in once.
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { Schema } from "effect"

import { hostOf } from "./accounts.ts"
import * as chrome from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { HOME, isJson } from "./chrome.ts"
import { browserFills, done, nowOn, num, str } from "./common.ts"
import type { Done } from "./common.ts"
import { luhn, redactUrl } from "./guard.ts"
import { dropSession, session } from "./session.ts"
import { parseKey, Tab } from "./tab.ts"
import { keychainDelete, keychainRead, keychainWrite, readJson, writePrivate } from "./vault.ts"

const SERVICE = "Switch secret"
const INDEX = path.join(HOME, "secrets.json")

export const KINDS = [
  "card-number",
  "security-code",
  "month",
  "year",
  "expiry",
  "ssn",
  "digits",
  "text",
] as const
export type Kind = (typeof KINDS)[number]

/** What's known of a kept secret that isn't secret. */
export interface Item {
  /** What it is, in a few words: "Visa ••4242, security code". */
  label: string
  kind: Kind
  /** How many characters it holds. */
  chars: number
  /** A card number's last four digits, as receipts print them. */
  last4?: string
  /** The only sites it may be filled on (their subdomains too); none, any secure page. */
  sites?: string[]
  /** Where it came from. */
  from: string
  saved: number
  used?: number
}

const NAMES: Record<Kind, string> = {
  "card-number": "a card number",
  "security-code": "a security code",
  month: "a month",
  year: "a year",
  expiry: "an expiry date",
  ssn: "a social security number",
  digits: "a number",
  text: "text",
}

/** The value as it's kept, or why it isn't one of these; neither the value nor any part of it is in the error. */
export const normalize = (kind: Kind, given: string) => {
  const raw = given.trim()
  const digits = raw.replaceAll(/\D/gu, "")
  const only = (allowed: string) => raw.split("").every((c) => /\d/u.test(c) || allowed.includes(c))
  const n = digits.length
  if (kind === "card-number" && only(" -") && n >= 13 && n <= 19 && luhn(digits)) {
    return digits
  }
  if (kind === "security-code" && only("") && (n === 3 || n === 4)) {
    return digits
  }
  if (
    kind === "month" &&
    only("") &&
    n >= 1 &&
    n <= 2 &&
    Number(digits) >= 1 &&
    Number(digits) <= 12
  ) {
    return digits.padStart(2, "0")
  }
  if (kind === "year" && only("") && (n === 2 || n === 4)) {
    return n === 2 ? `20${digits}` : digits
  }
  if (
    kind === "expiry" &&
    only("/ -") &&
    (n === 4 || n === 6) &&
    Number(digits.slice(0, 2)) >= 1 &&
    Number(digits.slice(0, 2)) <= 12
  ) {
    return `${digits.slice(0, 2)}/${digits.slice(-2)}`
  }
  if (kind === "ssn" && only("- ") && n === 9) {
    return digits
  }
  if (kind === "digits" && only("- ") && n >= 1 && n <= 64) {
    return digits
  }
  if (kind === "text" && raw !== "" && raw.length <= 256) {
    return raw
  }
  throw new Error(`That isn't ${NAMES[kind]}`)
}

/** A secret's name: lowercase letters, digits and - _ . /, like card/main.cvc or id/ssn. */
export const checkName = (name: string) => {
  const ok =
    /^[a-z0-9](?:[a-z0-9._/-]{0,62}[a-z0-9])?$/u.test(name) &&
    !name.includes("..") &&
    !name.includes("//")
  if (!ok) {
    throw new Error(
      `A secret's name is lowercase letters, digits and - _ . / (at most 64), like card/main.cvc, not ${JSON.stringify(name)}`,
    )
  }
}

const itemSchema = Schema.Struct({
  label: Schema.String,
  kind: Schema.Literals(KINDS),
  chars: Schema.Finite,
  last4: Schema.optionalKey(Schema.String),
  sites: Schema.optionalKey(Schema.Array(Schema.String)),
  from: Schema.String,
  saved: Schema.Finite,
  used: Schema.optionalKey(Schema.Finite),
})
const index = Schema.Record(Schema.String, itemSchema)

const mutable = (it: typeof itemSchema.Type): Item => {
  const { sites, ...rest } = it
  return sites === undefined ? rest : { ...rest, sites: [...sites] }
}

export const list = (): Record<string, Item> =>
  Object.fromEntries(Object.entries(readJson(INDEX, index, {})).map(([n, it]) => [n, mutable(it)]))

const item = (name: string) => {
  const all = list()
  const found = all[name]
  if (found) {
    return found
  }
  const names = Object.keys(all)
  throw new Error(
    `This Mac keeps no secret ${JSON.stringify(name)}${names.length === 0 ? " (it keeps none yet: secret import keeps a card the browser has saved)" : `; it keeps ${names.join(", ")}`}`,
  )
}

const value = async (name: string) => {
  const kept = await keychainRead(SERVICE, name)
  if (!isJson(kept) || typeof kept.value !== "string") {
    throw new Error(`${name}'s Keychain item is gone: keep it again`)
  }
  return kept.value
}

/** Keeps a secret: its Keychain item first (checked as it reads back), then what's known of it. */
export const keep = async (name: string, it: Item, secret: string) => {
  checkName(name)
  await keychainWrite(SERVICE, name, { value: secret })
  writePrivate(INDEX, JSON.stringify({ ...list(), [name]: it }, null, 2))
}

const touch = (name: string) => {
  const all = list()
  const it = all[name]
  if (it) {
    it.used = Date.now()
    writePrivate(INDEX, JSON.stringify(all, null, 2))
  }
}

/** Takes a secret away, or every one in a group (`card/main` takes `card/main.number` and the rest). */
export const forget = async (name: string) => {
  const all = list()
  const gone = Object.keys(all).filter((n) => n === name || n.startsWith(`${name}.`))
  if (gone.length === 0) {
    item(name)
  }
  for (const n of gone) {
    await keychainDelete(SERVICE, n)
  }
  writePrivate(
    INDEX,
    JSON.stringify(
      Object.fromEntries(Object.entries(all).filter(([n]) => !gone.includes(n))),
      null,
      2,
    ),
  )
  return gone
}

/** Whether a secret may go into the page at `url`: over HTTPS, and on one of its sites when it has some. */
const secure = (url: string, sites: readonly string[]) => {
  const host = hostOf(url)
  const local = host === "localhost" || host === "127.0.0.1"
  if (!(url.startsWith("https://") || (local && url.startsWith("http://")))) {
    throw new Error(
      `The tab is on ${redactUrl(url)}, which isn't HTTPS: a secret only goes into a secure page`,
    )
  }
  if (sites.length > 0 && !sites.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new Error(`The tab is on ${host}, and that secret is kept only for ${sites.join(", ")}`)
  }
}

/**
 * The part of a secret a field takes (`slice`, [start, end] by character) in the shape it takes it
 * (`format`, each # its next letter or digit, like ##/## or ###-##-####).
 */
const shaped = (secret: string, args: Json) => {
  const chars = secret.split("")
  let part = chars
  if (Array.isArray(args.slice)) {
    const [from, to] = args.slice.map((x) => num(x) ?? -1)
    if (from === undefined || to === undefined || from < 0 || from >= to || to > chars.length) {
      throw new Error(`slice doesn't fit in its ${chars.length} characters`)
    }
    part = chars.slice(from, to)
  }
  const format = str(args.format)
  if (format === "") {
    return part.join("")
  }
  const next = part.filter((c) => /[\p{L}\p{N}]/u.test(c))
  let at = 0
  let out = ""
  for (const f of format) {
    if (f === "#") {
      const c = next[at]
      if (c === undefined) {
        throw new Error("format has more # than it has letters and digits")
      }
      out += c
      at += 1
    } else {
      out += f
    }
  }
  if (at < next.length) {
    throw new Error("format has fewer # than it has letters and digits")
  }
  return out
}

/** `fill_secret`: one of this Mac's secrets into a field, checked by its length after, and sealed. */
export const fillSecret = async (tab: Tab, args: Json, n: number): Promise<Done> => {
  const name = str(args.secret).trim()
  if (name === "") {
    throw new Error("fill_secret needs secret: a kept secret's name (the secret tool lists them)")
  }
  const it = item(name)
  const { url } = await tab.info()
  secure(url, it.sites ?? [])
  const fp = tab.known(n)
  const field = await tab.pageJson(`field(${n}, ${fp})`)
  const fieldLine = str(field.line) || "the field"
  const dropdown = field.tag === "select"
  if (!dropdown && field.editable !== true) {
    throw new Error(
      `${fieldLine} isn't a field that can be filled: name the text box or dropdown itself`,
    )
  }
  const put = shaped(await value(name), args)
  const wanted = put.length
  if (dropdown) {
    await tab.page(`chooseSecret(${n}, ${fp}, ${JSON.stringify(put)})`)
  } else {
    const length = await tab.fillHidden(n, put)
    // A field that spaces a card's digits out holds more characters, but the same digits.
    const digits = put.replaceAll(/\D/gu, "").length
    const held = await tab.pageJson(`held(${n}, ${fp})`)
    if (length !== wanted && !(digits > 0 && num(held.digits) === digits)) {
      await tab.press(parseKey("cmd+a"))
      await tab.press(parseKey("Backspace"))
      throw new Error(
        `${fieldLine} held ${length} characters after filling ${name}, not its ${wanted}: the field cuts or changes it, so I emptied it again (format or slice shapes it)`,
      )
    }
  }
  const now = await tab.info()
  if (hostOf(now.url) !== hostOf(url)) {
    throw new Error(
      `The tab went to ${redactUrl(now.url)} while ${name} was going in, so I stopped there`,
    )
  }
  await tab.page(`seal(${n}, ${fp})`)
  touch(name)
  return done(
    `Filled ${fieldLine} with ${name} (${it.label}, ${wanted} characters). It counts as a payment or identity field now, which nothing reads back.\n${await nowOn(tab)}`,
  )
}

/** Where a saved card is filled to be kept: a page with nothing running on it, over HTTPS. */
const BLANK = "https://example.com/"
/** How long the browser may take to fill a saved card (ms). */
const FILLING = 15_000

/** The browser fills a card it has saved into the spur's own form; what it filled, never returned. */
const filledCard = async (tab: Tab, pick: string) => {
  await tab.navigate(BLANK)
  await tab.page("cardForm()")
  const snapshot = await tab.snapshot(50, false, false)
  const numberField = snapshot.elements.find((e) => e.label.includes("Card number"))
  if (!numberField) {
    throw new Error("The card form has no number field")
  }
  const offered = await browserFills(tab, await tab.point(numberField.n), pick)
  if (offered.chose === null) {
    throw new Error("The browser filled nothing")
  }
  const since = Date.now()
  for (;;) {
    const filled = await tab.pageJson("cardFilled()")
    const has = (f: string) => (num(filled[f]) ?? 0) > 0
    // The code comes with the number, or not at all; a moment more lets it land.
    if (has("number") && (has("cvc") || Date.now() - since > FILLING / 2)) {
      break
    }
    if (Date.now() - since > FILLING) {
      throw new Error(
        `The browser chose "${offered.chose}" but left the card's number empty: it may be asking to verify it's the user (Touch ID or the Mac's password)`,
      )
    }
    await Bun.sleep(300)
  }
  return { chose: offered.chose, values: await tab.pageJson("harvest()") }
}

/** The `secret` tool's import: a card the browser has saved, kept as `name`'s number, cvc, expiry and name. */
export const importCard = async (pick: string, name: string, label: string | null) => {
  checkName(name)
  await chrome.reach()
  const id = `secret-import-${crypto.randomUUID().slice(0, 8)}`
  const s = session(id)
  let filled: Awaited<ReturnType<typeof filledCard>>
  try {
    filled = await s.locked(async () => {
      const tab = new Tab(s)
      await tab.ensure()
      try {
        return await filledCard(tab, pick)
      } finally {
        // Whatever happened, the page is emptied and its tab closed.
        await tab.page("wipe()").catch(() => null)
      }
    })
  } finally {
    await chrome.call("release", { session: id, keepOpen: false }, 15_000).catch(() => null)
    dropSession(id)
  }
  const { chose, values } = filled
  const called = label ?? (chose.split(" • ")[0] ?? chose).trim()
  const number = normalize("card-number", str(values.number))
  const last4 = number.slice(-4)
  const now = Date.now()
  const kept: [string, Item, string][] = []
  const add = (part: string, what: string, kind: Kind, secret: string) => {
    kept.push([
      `${name}.${part}`,
      {
        label: `${called}, ${what}`,
        kind,
        chars: secret.length,
        from: "the browser's saved cards",
        saved: now,
        ...(kind === "card-number" && { last4 }),
      },
      secret,
    ])
  }
  add("number", "number", "card-number", number)
  const missing: string[] = []
  const tryAdd = (part: string, what: string, kind: Kind, raw: string, lacking: string) => {
    try {
      add(part, what, kind, normalize(kind, raw))
    } catch {
      missing.push(lacking)
    }
  }
  tryAdd("cvc", "security code", "security-code", str(values.cvc), "its security code")
  try {
    const month = normalize("month", str(values.month))
    const year = normalize("year", str(values.year))
    add("month", "expiry month", "month", month)
    add("year", "expiry year", "year", year)
    add("expiry", "expiry (MM/YY)", "expiry", `${month}/${year.slice(2)}`)
  } catch {
    missing.push("its expiry")
  }
  tryAdd("name", "name on card", "text", str(values.name), "the name on it")
  for (const [n, it, secret] of kept) {
    await keep(n, it, secret)
  }
  const names = kept.map(([n, it]) => `${n} (${it.chars} characters)`).join(", ")
  return `Kept ${called} (ending ${last4}) from the browser's saved cards: ${names}. fill_secret puts one in a field.${missing.length > 0 ? ` The browser didn't fill ${missing.join(" or ")}.` : ""}`
}

/** Switchboard's macOS appendage, which this replaces: where it kept its secrets' index, and its service. */
const LEGACY = path.join(homedir(), "Library/Application Support/Switchboard/macos/secrets.json")
const LEGACY_SERVICE = "Switchboard secret"

/** Takes in the secrets the appendage this replaces kept, once each; says how many. */
export const importLegacy = async () => {
  if (!existsSync(LEGACY)) {
    return 0
  }
  const theirs = readJson(LEGACY, index, {})
  const ours = list()
  let taken = 0
  for (const [name, it] of Object.entries(theirs)) {
    if (ours[name]) {
      continue
    }
    try {
      const kept = await keychainRead(LEGACY_SERVICE, name)
      if (isJson(kept) && typeof kept.value === "string") {
        await keep(name, mutable(it), kept.value)
        taken += 1
      }
    } catch {
      // Its item can't be read here (a locked Keychain): tried again at the next start.
    }
  }
  return taken
}
