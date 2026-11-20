// The browser spur: this Mac's own browser (Chrome, or another Chromium browser), signed in as the
// user is there, driven through the spur's extension and the browser's debugger in background tabs,
// grouped and collapsed out of the way. `run` hands a routine goal to the user's decision model;
// `act` is exact control. Ported from Switchboard's browser appendage.
import { Effect, Schema } from "effect"
import { answer, defineApp, Models, tool } from "spur-kit"

import * as chrome from "./chrome.ts"
import type { Json } from "./chrome.ts"
import { redact } from "./guard.ts"
import { act, OPS } from "./ops.ts"
import type { Decide, Done } from "./common.ts"
import { run } from "./run.ts"
import { withTab } from "./tab.ts"
import type { Tab } from "./tab.ts"

const DEFAULT_SESSION = "browser"

const task = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (e) => (e instanceof Error ? e : new Error(String(e))) })

const output = (d: Done) =>
  answer({ text: redact(d.text) }, [
    { type: "text", text: redact(d.text) },
    ...d.images.map((i) => ({ type: "image" as const, data: i.data, mimeType: "image/jpeg" })),
  ])

/** Runs `work` on the named session's tab, once the extension is there. */
const onTab = (args: Json, work: (tab: Tab) => Promise<Done>) =>
  task(async () => {
    await chrome.reach()
    const name =
      typeof args.session === "string" && args.session !== "" ? args.session : DEFAULT_SESSION
    const group = typeof args.group === "string" ? args.group : null
    return output(await withTab(name, group, work))
  })

/** The user's decision model, as the profile's browse role runs it. */
const decider = Effect.gen(function* deciding() {
  const models = yield* Models
  const decide: Decide = async (input, questions) =>
    await Effect.runPromise(models.decide(input, questions, "browse"))
  return decide
})

const optionalString = Schema.optionalKey(Schema.String)
const optionalNumber = Schema.optionalKey(Schema.Finite)
const optionalBoolean = Schema.optionalKey(Schema.Boolean)
const strings = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

const runTool = tool(
  "run",
  {
    description:
      "Do a routine web task in the user's own browser on this Mac, signed in as they are there, with a fast decision model (about half a second a step): navigating, searching, following links, filling forms, multi-step clicking. Give one objective on one site with explicit steps (name exact link and button text when you know it), every string to type in facts, and files to upload in files. It works in a background tab (the session's, shared with act, so check and finish with act). It returns where the tab ended up and the steps it took, not an answer: status done (the model's belief, so check), blocked with why, max_steps, or needs_approval when the next step would commit something (send, submit, buy, post, delete): it stops there and gives the act call that does just that step, unless approved says the user asked for exactly this. Use act for fiddly widgets, judgment calls, reading, and anything visual. Never give it passwords, payment or identity numbers: it refuses them (act's sign_in signs in from the browser's saved passwords).",
    input: Schema.Struct({
      goal: Schema.String,
      url: optionalString,
      facts: strings,
      files: strings,
      max_steps: optionalNumber,
      approved: optionalBoolean,
      keystrokes: optionalBoolean,
      session: optionalString,
      group: optionalString,
    }),
  },
  (input) =>
    Effect.gen(function* running() {
      const decide = yield* decider
      return yield* onTab(input, async (tab) => await run(tab, input, decide))
    }),
)

const actTool = tool(
  "act",
  {
    description: `Exact control of a tab in the user's own browser on this Mac, signed in as they are there, in the background (a collapsed tab group; their own tabs and focus are left alone). Each session is one tab that lasts between calls. Ops: look (the page as an outline with numbered elements; view: screenshot for an annotated screenshot), find {text} (elements by words, else by meaning), click {element | match | x, y; button, count, modifiers}, type {text, element?, submit?, append?} (replaces a field's text and checks it), set {element, value} (a dropdown option, a checkbox, a date), sign_in {account?, otp?, submit?} (signs in from the browser's saved passwords: the browser itself fills the username and password, page after page, pressing Next or Enter after each, and nothing secret passes through you; account is words from the saved sign-in, like its username, and without it the one the browser offers; a page asking for a one-time code puts an action item in the user's queue and holds the tab, and otp then fills the code; a page asking again is reported, never retried), autofill {element | match | x, y; pick?} (the browser fills the field from what it has saved, a card's number, expiry and code at once: without pick it lists what it offers; pick is words from one, like a card's last four digits), key {keys: "Escape", "cmd+a", "Tab Tab Enter"}, hover, scroll {direction?, amount?, element | x, y}, drag {element | x, y, to}, screenshot {element? region? marks?}, text (the page's words), value {element, save_to?}, wait {text | gone | seconds}, navigate {url}, back, forward, reload, js {code} (JavaScript in the page; the last expression's value comes back), upload {element, paths}, dialog {accept, text?}, console, network {match? body?}, tabs, attach {tab: an id from tabs, or "front"}, show (brings the tab to the front of the screen), hold {hours?} (keeps it open for an approval), release {keep?}. steps: a list of ops run in order, stopping at the first that fails. Numbers stay with their element. match is text (or /regex/) in an element's line, like button "Send". Every op says where the tab is after it. sign_in and autofill bring the tab to the front for a few seconds, so they wait until nobody's using this Mac. Never type passwords, payment or identity numbers (refused). A committal click (send, submit, buy, post, delete) is the user's unless they asked for exactly that: hold the tab and ask for approval first.`,
    input: Schema.Struct({
      op: Schema.optionalKey(Schema.Literals(OPS)),
      steps: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
      session: optionalString,
      group: optionalString,
      element: optionalNumber,
      match: optionalString,
      index: optionalNumber,
      x: optionalNumber,
      y: optionalNumber,
      to: Schema.optionalKey(Schema.Unknown),
      url: optionalString,
      text: optionalString,
      submit: optionalBoolean,
      append: optionalBoolean,
      keystrokes: optionalBoolean,
      value: Schema.optionalKey(Schema.Unknown),
      pick: optionalString,
      account: optionalString,
      otp: optionalString,
      space: optionalString,
      keys: optionalString,
      repeat: optionalNumber,
      button: Schema.optionalKey(Schema.Literals(["left", "right", "middle"])),
      count: optionalNumber,
      modifiers: optionalString,
      direction: Schema.optionalKey(Schema.Literals(["down", "up", "left", "right"])),
      amount: optionalNumber,
      view: Schema.optionalKey(Schema.Literals(["text", "screenshot"])),
      region: Schema.optionalKey(Schema.Array(Schema.Finite)),
      marks: optionalBoolean,
      scale: optionalNumber,
      code: optionalString,
      seconds: optionalNumber,
      gone: optionalBoolean,
      timeout: optionalNumber,
      paths: Schema.optionalKey(Schema.Array(Schema.String)),
      accept: optionalBoolean,
      body: optionalString,
      errors: optionalBoolean,
      clear: optionalBoolean,
      tab: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
      keep: optionalBoolean,
      hours: optionalNumber,
      save_to: optionalString,
    }),
  },
  (input) =>
    Effect.gen(function* acting() {
      const decide = yield* decider
      return yield* onTab(input, async (tab) => await act(tab, input, decide))
    }),
)

export const browserApp = defineApp({
  name: "browser",
  version: "2",
  instructions:
    "The user's own browser on this Mac, signed in as they are there, in background tabs. run does routine web tasks with a decision model; act is exact control, and its sign_in signs in from the browser's saved passwords. Release sessions when done.",
  tools: [runTool, actTool],
})
