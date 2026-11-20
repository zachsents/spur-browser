# spur-browser

This Mac's own browser (Chrome, or another Chromium browser), signed in as the user is there, driven through the spur's extension and the browser's debugger in background tabs, grouped and collapsed out of the way. Two tools:

- `run`: a routine web task, step by step by the user's decision model (the profile's `browse` role). It stops before a step that would send, submit, buy, post or delete, unless the user asked for exactly that.
- `act`: exact control. Look, click, type, keys, scroll, screenshots, JavaScript, uploads, dialogs, console, network and tabs, and `sign_in`, which has the browser fill a sign-in from its saved passwords. Nothing secret passes through the agent: passwords, card and identity numbers are never typed or shown. A page asking for a one-time code puts an action item in the user's queue.

Ported from Switchboard's browser appendage and its extension.

A [Switch](https://switch.ax) spur, built on [spur-kit](https://github.com/zachsents/spur-kit).

## Install

Ask Switch's agent to install `github:zachsents/spur-browser`, or add it in the desktop's Spurs view
(⌘K, Spurs). It runs on a machine that provides `browser` (`provides` in `~/.switch/config.json`):
the Mac whose browser is signed in to what the user's spurs need, and that nobody's using, since
`sign_in` and `autofill` bring the tab to the front for a few seconds.

## Setup

Once per Mac, after the spur's first start writes the extension to `~/.switch/browser/extension`:
`chrome://extensions`, Developer mode on, Load unpacked, that folder. It updates itself from then on.
Accessibility belongs to the app the host runs under (for `sign_in` and `autofill`).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
