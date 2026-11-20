// The browser spur as a stdio MCP server: what a host runs. It writes the extension and its relay
// where the browser loads them, then takes the relay's connection.
import { Models, serveStdio } from "spur-kit"

import { browserApp } from "./app.ts"
import { install, serve } from "./chrome.ts"

install()
serve()
await serveStdio(browserApp, Models.layer)
// The host went: the socket the browser connects to goes with this process.
process.exit(0)
