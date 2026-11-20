// The browser spur as a stdio MCP server: what a host runs. It writes the extension and its relay
// where the browser loads them, takes in what the appendage it replaces kept, then takes the relay's
// connection and says what's in front.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { Effect, Layer } from "effect"
import { AppEvents, Models, serve } from "spur-kit"

import * as accounts from "./accounts.ts"
import { browserApp, watch } from "./app.ts"
import { install, serve as listen } from "./chrome.ts"
import * as secrets from "./secrets.ts"

install()
listen()
await accounts.importLegacy()
await secrets.importLegacy()
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* serving() {
      const done = yield* serve(browserApp, new StdioServerTransport())
      yield* Effect.forkScoped(watch)
      yield* done
    }),
  ).pipe(Effect.provide(Layer.provideMerge(Models.layer, AppEvents.layer(browserApp)))),
)
// The host went: the socket the browser connects to goes with this process.
process.exit(0)
