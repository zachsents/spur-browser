# spur-browser

This machine's Chrome, driven through Agent Quick Browse's MCP server as it is: navigating, reading pages, clicking and typing in background tabs, with the user's own sign-ins. A plain MCP server: no events or widgets.

A [Switch](https://switch.ax) spur: a plain MCP server with a spur manifest ([spur-kit](https://github.com/zachsents/spur-kit)).

## Install

Ask Switch's agent to install `github:zachsents/spur-browser`, or add it in the desktop's Spurs view
(⌘K, Spurs). Switch runs it on the first machine with what it needs.

## Setup

Agent Quick Browse's Chrome extension on the machine, and its decision model's key in the
environment or `~/.aqb/env`. The machine must provide `browser` (`provides` in
`~/.switch/config.json`).

## Develop

```sh
bun install
bun run check
bun start   # serves MCP on stdio
```
