// Switch's browser spur in Chrome (or another Chromium browser), over native messaging to the spur
// on this Mac: agents drive tabs here through the debugger (hands.js). Ported from Switchboard's
// extension, hands only.

importScripts("hands.js")

const HOST = "ax.switch.browser"
let port = null

function connect() {
  if (port) return
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch {
    setTimeout(connect, 30000)
    return
  }
  port.onMessage.addListener(onMessage)
  port.onDisconnect.addListener(() => {
    port = null
    setTimeout(connect, 10000)
  })
  // The spur asks for a reload when it has written newer files than these (it stamps their hash as version_name).
  const manifest = chrome.runtime.getManifest()
  port.postMessage({
    type: "hello",
    version: manifest.version_name ?? manifest.version,
    release: manifest.version,
  })
}

// The browser stops an idle worker, and the retry above with it: the alarm wakes it, and it connects again as it starts.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "reconnect" && !port) connect()
})
chrome.alarms
  .get("reconnect")
  .then((alarm) => alarm || chrome.alarms.create("reconnect", { periodInMinutes: 1 }))

/** Sends to the spur, if it's there. */
function emit(message) {
  port?.postMessage(message)
}

/** Reloads from the files on disk, at most once in ten minutes, so files that failed to update can't loop it. */
async function reloadOnce() {
  const { reloadedAt } = await chrome.storage.local.get("reloadedAt")
  if (reloadedAt && Date.now() - reloadedAt < 10 * 60_000) return
  await chrome.storage.local.set({ reloadedAt: Date.now() })
  chrome.runtime.reload()
}

async function onMessage(message) {
  if (message.type === "call") return answer(message)
  if (message.type === "reload") return reloadOnce()
}

/** One of the hands' calls, answered with its result or why it failed. */
async function answer({ id, method, params }) {
  try {
    const handler = hands[method]
    if (!handler) throw new Error(`the extension has no ${method}`)
    emit({ type: "reply", id, result: (await handler(params ?? {})) ?? null })
  } catch (error) {
    emit({ type: "reply", id, error: error instanceof Error ? error.message : String(error) })
  }
}

connect()
