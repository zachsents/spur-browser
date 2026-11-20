// Signing in with the browser's saved passwords. `sign_in` has the browser itself fill a sign-in
// page's username and password from its password manager (its own suggestions, picked through
// Accessibility), page after page (email, then password), and sends each on. A page asking for a
// one-time code is filled from `otp`; without one, the user is asked for it with an action item and
// the tab is held for it. A field still there after it was sent is reported, never retried. Nothing
// secret ever passes through here: what was filled is said by how many characters it holds.
// Ported from Switchboard's signin.rs, filling from the browser instead of a vault of its own.
import * as chrome from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { isJson } from "./chrome.ts"
import { actionItem } from "./core.ts"
import { browserFills, done, nowOn, num, str, whatAt } from "./common.ts"
import type { Done } from "./common.ts"
import { parseKey } from "./tab.ts"
import type { Tab } from "./tab.ts"

/** Pages a sign-in can take: email, password, code, and a spare. */
const ROUNDS = 6
/** How long a sign-in page's next step may take to show its fields (ms). */
const NEXT_PAGE = 2500

interface Field {
  readonly n: number
  readonly fp: string
  readonly kind: string
  readonly boxes: number
  readonly length: number
  readonly line: string
}

const fieldsOf = (found: unknown): Field[] =>
  (Array.isArray(found) ? found : []).filter(isJson).flatMap((f) => {
    const n = num(f.n)
    return n === null
      ? []
      : [
          {
            n,
            fp: str(f.fp),
            kind: str(f.kind),
            boxes: num(f.boxes) ?? 1,
            length: num(f.length) ?? 0,
            line: str(f.line),
          },
        ]
  })

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return ""
  }
}

/** Sends a filled field's form on: its submit button, else Enter. */
const send = async (tab: Tab, field: Field) => {
  const since = Date.now()
  const button = num(
    await tab.page(`submitter(${field.n}, ${JSON.stringify(field.fp)})`).catch(() => null),
  )
  let how: string
  if (button === null) {
    await tab.press(parseKey("Enter"))
    how = "pressed Enter"
  } else {
    const at = await tab.point(button)
    how = `pressed ${await whatAt(tab, at)}`
    await tab.clickAt(at)
  }
  await tab.settle(since)
  return how
}

/** Waits a few seconds for the page to move on from the fields just sent. */
const movedOn = async (tab: Tab, sent: readonly Field[]) => {
  const ns = new Set(sent.map((f) => f.n))
  const until = Date.now() + 6000
  while (Date.now() < until) {
    const found = fieldsOf(await tab.page("signin()").catch(() => []))
    if (!found.some((f) => ns.has(f.n))) {
      return
    }
    await Bun.sleep(300)
  }
}

/** How many characters a field holds now, never what they are. */
const lengthOf = async (tab: Tab, f: Field) =>
  num(await tab.page(`length(${f.n}, ${JSON.stringify(f.fp)})`).catch(() => null)) ?? 0

/** A one-time code into its field: typed box by box when it's split one character to a box. */
const putCode = async (tab: Tab, f: Field, code: string) => {
  if (f.boxes > 1) {
    await tab.clickAt(await tab.point(f.n))
    await tab.keystrokes(code)
    return fieldsOf(await tab.page("signin()")).find((x) => x.n === f.n)?.length ?? 0
  }
  return await tab.fillHidden(f.n, code)
}

/**
 * Has the browser fill a sign-in from its saved passwords: `account` is words in its suggestion
 * (the username, usually); without it, the one it offers, or the list when it offers several.
 */
export const signIn = async (tab: Tab, args: Json): Promise<Done> => {
  let pick =
    typeof args.account === "string" && args.account.trim() !== "" ? args.account.trim() : null
  const otp = typeof args.otp === "string" && args.otp.trim() !== "" ? args.otp.trim() : null
  const submit = args.submit !== false
  const { url } = await tab.info()
  const host = hostOf(url)
  const steps: string[] = []
  const filled = new Set<string>()
  const sentFields = new Set<number>()
  let ending = ""
  for (let round = 0; round < ROUNDS; round += 1) {
    // After the first page, the next one's fields may come a beat after the last one's went.
    const started = Date.now()
    let found = fieldsOf(await tab.page("signin()"))
    const todo = () =>
      found.filter(
        (f) =>
          (f.kind === "username" || f.kind === "password" || (f.kind === "code" && otp !== null)) &&
          !filled.has(f.kind),
      )
    const wait = round > 0 ? NEXT_PAGE : 0
    while (todo().length === 0 && Date.now() - started < wait) {
      await Bun.sleep(250)
      found = fieldsOf(await tab.page("signin()"))
    }
    const left = todo()
    if (left.length === 0) {
      const refused = ["password", "code"].filter(
        (k) => filled.has(k) && found.some((f) => f.kind === k && sentFields.has(f.n)),
      )
      if (refused.length > 0) {
        ending = `The page still shows the ${refused.join(" and ")} field after it was sent, so it was likely refused or didn't go; I didn't fill it again (that can lock an account). Read the page for why.`
      } else if (found.some((f) => f.kind === "code")) {
        await chrome
          .call("hold", { session: tab.name, until: Date.now() + 3_600_000 }, 10_000)
          .catch(() => null)
        const asked = await actionItem(
          `${host} code`,
          `The sign-in to ${host} is filled from your saved password and sent; it sent you a one-time code by text, email or app. Reply with the code and I'll finish signing in.`,
          typeof args.space === "string" ? args.space : "Home",
        )
        ending = `The page asks for a one-time code. ${asked ? "The user is asked for it with an action item" : "Ask the user for it with an action item"} (or find it in their texts or email), then sign_in with otp. The tab is held for an hour.`
      } else if (found.some((f) => f.kind === "new password")) {
        ending = "The page wants a new password: that's the user's to set."
      } else if (round === 0) {
        throw new Error("There's no sign-in field here: open the site's sign-in page first")
      } else {
        ending = "No sign-in field is left to fill."
      }
      break
    }
    const said: string[] = []
    const code = left.find((f) => f.kind === "code")
    const credential = left.find((f) => f.kind === "username" || f.kind === "password")
    if (credential) {
      const at = await tab.point(credential.n)
      if (pick === null) {
        // The one saved sign-in the browser offers here, else the list to choose from.
        const offered = await browserFills(tab, at, null)
        const [only, ...more] = offered.labels
        if (only === undefined || more.length > 0) {
          return done(
            `The browser offers these saved sign-ins for ${host}:\n${offered.labels.map((l) => `- ${l}`).join("\n")}\nsign_in again with account: words from one.`,
          )
        }
        pick = only
      }
      const offered = await browserFills(tab, at, pick)
      await Bun.sleep(400)
      for (const f of left.filter((x) => x.kind === "username" || x.kind === "password")) {
        const held = await lengthOf(tab, f)
        if (held > 0) {
          filled.add(f.kind)
          said.push(
            f.kind === "password"
              ? `the password into ${f.line} (${held} characters)`
              : `the username into ${f.line}`,
          )
        }
      }
      if (said.length === 0) {
        throw new Error(
          `The browser chose "${offered.chose ?? pick}" but the fields still read empty: it may be asking to verify it's the user (Touch ID or the Mac's password); look at a screenshot`,
        )
      }
    } else if (code && otp !== null) {
      const held = await putCode(tab, code, otp)
      if (held === 0) {
        throw new Error(`${code.line} still reads empty after filling the code: look at the page`)
      }
      filled.add("code")
      said.push(`the one-time code into ${code.line}`)
    }
    const last = left.findLast((f) => filled.has(f.kind)) ?? left[0]
    if (!last) {
      break
    }
    if (!submit) {
      steps.push(`filled ${said.join(", ")}`)
      ending = "Not sent on (submit: false)."
      break
    }
    for (const f of left) {
      sentFields.add(f.n)
    }
    steps.push(`filled ${said.join(", ")}, then ${await send(tab, last)}`)
    await movedOn(tab, left)
  }
  const list = steps.map((s) => `- ${s}`).join("\n")
  return done(
    `Signing in to ${host}${pick === null ? "" : ` with the saved sign-in "${pick}"`}:\n${list}\n${ending}\n${await nowOn(tab)}`,
  )
}
