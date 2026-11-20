// Stored accounts: sign-ins this Mac keeps for sites the browser has no saved password for, so the
// browser fills them itself (`sign_in`), and an authenticator key, so it makes the code too. An agent
// names the account; its password and key never come back and never go in a request or result.
// What's secret (the password, the one before it, the authenticator key) is one login Keychain item
// per account; what isn't (the username, the sites it may be filled on, what it holds, when it was
// saved and last used) is in accounts.json beside the extension. Ported from Switchboard's
// accounts.rs, whose accounts it takes in once.
import { createHmac, randomInt } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { Schema } from "effect"

import { HOME } from "./chrome.ts"
import { keychainDelete, keychainRead, keychainWrite, readJson, writePrivate } from "./vault.ts"

const SERVICE = "Switch account"
const INDEX = path.join(HOME, "accounts.json")

/** What's known of an account that isn't secret. */
export interface Account {
  username?: string
  /** Sites it may be filled on: a host, or a domain whose subdomains count too. */
  sites: string[]
  password: boolean
  totp: boolean
  /** When it was last saved and last filled, in ms since 1970. */
  saved: number
  used?: number
}

const accountSchema = Schema.Struct({
  username: Schema.optionalKey(Schema.String),
  sites: Schema.Array(Schema.String),
  password: Schema.Boolean,
  totp: Schema.Boolean,
  saved: Schema.Finite,
  used: Schema.optionalKey(Schema.Finite),
})
const index = Schema.Record(Schema.String, accountSchema)

/** An authenticator key (RFC 6238), as an `otpauth://` link carries it. */
export interface Totp {
  /** The key, base32 as sites show it, without spaces. */
  secret: string
  digits: number
  period: number
  /** SHA1 (nearly every site), SHA256 or SHA512. */
  algorithm: string
}

/** What's secret, as the Keychain item holds it. */
export interface Secrets {
  password?: string
  /** The password before the last one generated, in case the site never took the new one. */
  previous?: string
  totp?: Totp
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** How long a key shown as text usually is, in base32 letters. */
const KEY_LENGTHS = new Set([16, 24, 26, 32, 52, 64, 103])

/** Words a page puts around a key it shows, spelled only in base32's letters. */
const COMMON_WORDS = new Set(
  (
    "a an as at be by do go if in is it me my no of on or so to up us we the and for you key app can use add not are all any new now our get set see one " +
    "two via its has but how tap this that then than code with your here next copy type scan into from when once done save back also only just what them " +
    "they will open more page keys need make sure have time show find both same must turn box"
  ).split(" "),
)

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Base32 (RFC 4648) in any case, without padding. */
const base32 = (text: string) => {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const c of text.toUpperCase().replaceAll(/[ =-]/gu, "")) {
    const value = BASE32.indexOf(c)
    if (value === -1) {
      throw new Error("That key isn't base32 (A-Z and 2-7)")
    }
    buffer = (buffer << 5) | value
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
      buffer &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

const checked = (t: Totp): Totp => {
  const secret = t.secret.replaceAll(/[ =-]/gu, "").toUpperCase()
  if (base32(secret).length < 10) {
    throw new Error(
      "That key is too short to be an authenticator key: read the whole key, or the otpauth link",
    )
  }
  const sane = t.digits >= 6 && t.digits <= 8 && t.period >= 10 && t.period <= 120
  if (!sane || !["SHA1", "SHA256", "SHA512"].includes(t.algorithm)) {
    throw new Error("That key asks for codes authenticators don't make")
  }
  return { ...t, secret }
}

const isBase32 = (w: string) => w !== "" && /^[A-Za-z2-7]+$/u.test(w)

/** A word's case: 1 upper, 2 lower, 0 neither (digits alone), null both (no part of a key). */
const caseOf = (w: string) => {
  const upper = /[A-Z]/u.test(w)
  const lower = /[a-z]/u.test(w)
  if (upper && lower) {
    return null
  }
  if (upper) {
    return 1
  }
  return lower ? 2 : 0
}

/** Every run of base32 in some words that could be a key shown as text (Google shows it in groups of four). */
const runs = (text: string) => {
  const all: string[][] = []
  let run: string[] = []
  let runCase = 0
  let open = false
  const close = () => {
    all.push(run)
    run = []
  }
  for (const token of text.split(/\s+/u).filter(Boolean)) {
    const core = token.replaceAll(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "")
    const led = !token.startsWith(core)
    const trailed = !token.endsWith(core)
    const word = core.replaceAll("-", "")
    const wordCase = isBase32(word) ? caseOf(word) : null
    if (wordCase === null) {
      close()
      open = false
      continue
    }
    if (word.length > 4) {
      close()
      all.push([word])
      open = false
      continue
    }
    if (!(open && !led && (runCase === 0 || wordCase === 0 || runCase === wordCase))) {
      close()
      runCase = 0
    }
    runCase = Math.max(runCase, wordCase)
    run.push(word)
    open = !trailed && word.length >= 4
    if (!open) {
      close()
    }
  }
  close()
  return all
    .filter((r) => r.length > 0)
    .map((r) => {
      let front = 0
      let back = r.length
      while (back - front > 1 && COMMON_WORDS.has((r[front] ?? "").toLowerCase())) {
        front += 1
      }
      while (back - front > 1 && COMMON_WORDS.has((r[back - 1] ?? "").toLowerCase())) {
        back -= 1
      }
      return r.slice(front, back).join("")
    })
}

/**
 * A key from what a two-factor setup page shows: an `otpauth://totp/…` link, or the key itself.
 * `needsDigit`: a key shown as text must have a digit, so no run of ordinary words is taken for one.
 */
export const parseTotp = (raw: string, needsDigit = false): Totp => {
  const text = raw.trim()
  const at = text.indexOf("otpauth://")
  if (at !== -1) {
    const link = text.slice(at).split(/[\s"']/u)[0] ?? ""
    const rest = link.slice("otpauth://".length)
    const [kind = "", query = ""] = rest.split("?")
    if (!kind.toLowerCase().startsWith("totp/")) {
      throw new Error("That's a counter-based (HOTP) key, not a time-based one")
    }
    const params = new URLSearchParams(query)
    return checked({
      secret: params.get("secret") ?? "",
      digits: Number(params.get("digits") ?? 6),
      period: Number(params.get("period") ?? 30),
      algorithm: (params.get("algorithm") ?? "SHA1").toUpperCase(),
    })
  }
  const [best] = runs(text)
    .filter((k) => k.length >= 16 && (!needsDigit || /\d/u.test(k)))
    .toSorted(
      (a, b) =>
        Number(KEY_LENGTHS.has(b.length)) - Number(KEY_LENGTHS.has(a.length)) ||
        b.length - a.length,
    )
  if (best === undefined) {
    throw new Error(
      `There's no authenticator key in that text: point at the key itself ("Can't scan it?" shows it), or the otpauth link`,
    )
  }
  return checked({ secret: best, digits: 6, period: 30, algorithm: "SHA1" })
}

/** The code for a moment (seconds since 1970). */
export const totpCode = (t: Totp, unix: number) => {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(unix / t.period)))
  const mac = createHmac(t.algorithm.toLowerCase(), base32(t.secret)).update(counter).digest()
  const offset = (mac.at(-1) ?? 0) & 0x0f
  const value = mac.readUInt32BE(offset) & 0x7f_ff_ff_ff
  return String(value % 10 ** t.digits).padStart(t.digits, "0")
}

/** The code now, waiting for the next one when this one has under three seconds left. */
export const currentCode = async (t: Totp) => {
  const unix = Date.now() / 1000
  const left = t.period - (unix % t.period)
  if (left < 3) {
    await Bun.sleep(left * 1000 + 300)
  }
  return totpCode(t, Date.now() / 1000)
}

const GENERATED = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@"

/** A strong random password (12 to 64 characters), with upper, lower, a digit and a symbol. */
export const generate = (length: number) => {
  if (length < 12 || length > 64) {
    throw new Error(`A generated password is 12 to 64 characters long, not ${length}`)
  }
  for (;;) {
    const password = Array.from({ length }, () => GENERATED[randomInt(GENERATED.length)]).join("")
    if (
      /[A-Z]/u.test(password) &&
      /[a-z]/u.test(password) &&
      /\d/u.test(password) &&
      /[^A-Za-z0-9]/u.test(password)
    ) {
      return password
    }
  }
}

/** A name an account can have: short, lowercase, no spaces. */
export const checkName = (name: string) => {
  if (!/^[a-z0-9][a-z0-9._@-]{0,63}$/u.test(name)) {
    throw new Error(
      `An account's name is lowercase letters, digits and - _ . @ (at most 64), like shop-admin, not ${JSON.stringify(name)}`,
    )
  }
}

/** The host of a URL, lowercase, without its port. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/** A site as it's kept: a host or domain, lowercase, without a scheme, path or port. */
export const site = (text: string) => {
  const host = (hostOf(text) || text.trim().replace(/^\*\./u, "").toLowerCase()).replace(
    /^www\./u,
    "",
  )
  if (host === "" || !(host.includes(".") || host === "localhost") || /[/ *]/u.test(host)) {
    throw new Error(`${JSON.stringify(text)} isn't a site: give a host or domain like example.com`)
  }
  return host
}

/** Whether something kept for `sites` may be filled on the page at `url`: one of them, over HTTPS. */
export const allows = (sites: readonly string[], url: string, what = "a stored account") => {
  const host = hostOf(url)
  const local = host === "localhost" || host === "127.0.0.1"
  if (!url.startsWith("https://") && !(local && url.startsWith("http://"))) {
    throw new Error(`The tab isn't on an HTTPS page: ${what} is only filled on a secure page`)
  }
  if (!sites.some((s) => host === s || host.endsWith(`.${s}`))) {
    throw new Error(
      `The tab is on ${host}, and ${what} is kept for ${sites.length === 0 ? "no site yet" : sites.join(", ")}: it's never filled anywhere else`,
    )
  }
}

export const list = (): Record<string, Account> =>
  Object.fromEntries(
    Object.entries(readJson(INDEX, index, {})).map(([n, a]) => [n, { ...a, sites: [...a.sites] }]),
  )

/** One account, or an error that names the ones there are. */
export const account = (name: string) => {
  const all = list()
  const found = all[name]
  if (found) {
    return found
  }
  const names = Object.keys(all)
  throw new Error(
    `This Mac has no stored account ${JSON.stringify(name)}${names.length === 0 ? "" : `; it has ${names.join(", ")}`}`,
  )
}

const toSecrets = (v: unknown): Secrets => {
  if (!isRecord(v)) {
    return {}
  }
  const out: Secrets = {}
  if (typeof v.password === "string") {
    out.password = v.password
  }
  if (typeof v.previous === "string") {
    out.previous = v.previous
  }
  const t = v.totp
  if (isRecord(t) && typeof t.secret === "string") {
    out.totp = {
      secret: t.secret,
      digits: typeof t.digits === "number" ? t.digits : 6,
      period: typeof t.period === "number" ? t.period : 30,
      algorithm: typeof t.algorithm === "string" ? t.algorithm : "SHA1",
    }
  }
  return out
}

export const secrets = async (name: string) => toSecrets(await keychainRead(SERVICE, name))

/** Saves an account: its secrets first (checked as they read back), then the index. */
export const save = async (name: string, a: Account, s: Secrets) => {
  checkName(name)
  await keychainWrite(SERVICE, name, s)
  writePrivate(INDEX, JSON.stringify({ ...list(), [name]: a }, null, 2))
}

/** Notes when an account was last filled. */
export const touch = (name: string) => {
  const all = list()
  const a = all[name]
  if (a) {
    a.used = Date.now()
    writePrivate(INDEX, JSON.stringify(all, null, 2))
  }
}

export const forget = async (name: string) => {
  account(name)
  await keychainDelete(SERVICE, name)
  const { [name]: _, ...rest } = list()
  writePrivate(INDEX, JSON.stringify(rest, null, 2))
}

/** Switchboard's macOS appendage, which this replaces: where it kept its accounts' index, and its service. */
const LEGACY = path.join(homedir(), "Library/Application Support/Switchboard/macos/accounts.json")
const LEGACY_SERVICE = "Switchboard account"

/** Takes in the accounts the appendage this replaces kept, once each; says how many. */
export const importLegacy = async () => {
  if (!existsSync(LEGACY)) {
    return 0
  }
  const theirs = readJson(LEGACY, index, {})
  const ours = list()
  let taken = 0
  for (const [name, a] of Object.entries(theirs)) {
    if (ours[name]) {
      continue
    }
    try {
      const s = a.password || a.totp ? toSecrets(await keychainRead(LEGACY_SERVICE, name)) : {}
      await save(name, { ...a, sites: [...a.sites] }, s)
      taken += 1
    } catch {
      // Its item can't be read here (a locked Keychain): tried again at the next start.
    }
  }
  return taken
}
