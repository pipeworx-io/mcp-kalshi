# kalshi

Market data from **Kalshi**, the CFTC-regulated US prediction-market exchange.
Public reads need no credential; nothing in this pack ever touches an account.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

Upstream: `https://api.elections.kalshi.com/trade-api/v2` (docs:
<https://docs.kalshi.com/llms.txt>, which serves every endpoint page as `.md`).

## What is here

| Tool | What it answers |
|---|---|
| `kalshi_markets` / `kalshi_market` | find markets by subject; one market in full, including its settlement rules |
| `kalshi_events` / `kalshi_event` | an event and every child market (one per outcome bucket) |
| `kalshi_series` / `kalshi_macro` | the recurring question templates; friendly-name shortcuts (Fed, CPI, BTC…) |
| `kalshi_orderbook` / **`kalshi_orderbooks`** | depth of book for one market / for up to 100 at once |
| `kalshi_trades` | executed trades, live or archived |
| `kalshi_price_history` / **`kalshi_candlesticks`** | OHLC for one market with paging + archive fallback / for up to 100 on one shared window |
| `kalshi_top_markets` | most-traded markets right now |
| `kalshi_exchange_status` | is the floor open |
| **`kalshi_event_live_data`** | the real-world measurement an event settles against |
| **`kalshi_game_stats`** | live score + play-by-play for a sports milestone |
| **`kalshi_milestones`** | the occurrences Kalshi hangs markets off, and which events belong to each |
| **`kalshi_structured_targets`** | the entities (players, teams, actors, films, companies) markets refer to |
| **`kalshi_weather_index`** / **`kalshi_weather_index_calibrations`** | the city temperature index temperature markets settle on, and how it is computed |

Bold rows landed 2026-09-16 (fleet #2040). The bucket assignment for all eight
probed endpoint families, with the literal responses, is in
`docs/pack-build-queue.md`.

## Traps already paid for

**Kalshi filters Cloudflare egress on its listing endpoints.** Several endpoints
return empty to a Workers IP. The gateway injects `_proxyUrl`/`_proxyToken` and
`kalshiGet()` routes every upstream fetch through the relay when they are
present. Anything new must go through `kalshiGet`, never a bare `fetch`.

**Auth-gated vs broken is legible on this API, so check before concluding.** An
endpoint that needs a credential answers `401
{"error":{"code":"token_authentication_failure"}}`. A `400 bad_request` is the
handler refusing, not a missing key.

**`/markets/orderbooks` takes `tickers` repeated; `/markets/candlesticks` takes
`market_tickers` comma-separated.** Two batch endpoints on the same API, two
different array conventions. Getting it wrong is a 400, not a silent subset.

**The batch candlestick response labels each group `market_ticker`, not
`ticker`.** Pair by that label. Pairing by request order would attribute one
market's entire price history to another and still return 200.

**Kalshi caps batch candlesticks at 10,000 candles across ALL requested markets
and gives no cursor there.** `kalshi_candlesticks` reports
`truncated_by_upstream`. For one ticker over a long window — or a market old
enough to be archived — use `kalshi_price_history`, which pages and falls back to
the archive; the batch endpoint does neither.

**`/live_data/events/{ticker}` is 404 for most events, and that is normal.** It
exists for crypto price events and some economic-series events. `found:false` is
the honest answer, not an error. A live BTC event's payload is ~473 KB, which is
why series are trimmed to `max_points` with `series_trimmed` reporting the
untrimmed length.

**Weather is city-keyed, not event-keyed.** `KXHIGHNY-26SEP16` 404s on the event
live-data endpoint. The observations live at `/live_data/weather/{city}` and
exist whether or not a market is open.

**There are exactly thirteen weather-index city ids, and they are ids, not place
names**: `miami`, `dfw`, `houston`, `phl-delaware-valley`, `puget-sound`,
`sf-bay`, `greater-boston`, `southeast-michigan`, `kansas-city`,
`minneapolis-st-paul`, `nyc`, `chicago`, `la-coastal`. Kalshi enumerates them in
its own rejection message for an unknown city. `austin` is not one. The index is
per-minute, so a window under ~2 minutes can legitimately return zero points.
`from`/`to` here are unix **milliseconds**; `last_sec` is seconds.

**Weather-index station offsets are in Celsius while the index itself is
published in Fahrenheit.** (`kalshi_weather_index_calibrations`.)

**`/live_data/milestone/{id}/game_stats` answers 200 with `{"pbp":{}}` for a
milestone Sportradar does not cover** — verified on a college football game,
2026-09-16. `plays_available:false` says so rather than passing an empty array
off as a game with no plays. Documented coverage: Pro/College Football,
Pro/College Basketball, WNBA, Soccer, Pro Hockey, Pro Baseball.

**`/structured_targets` does not reject an unknown `type` — it returns 200 with
an empty list.** The types are granular by sport; there is no bare `player`,
`team` or `athlete` (`type=player` matches exactly one test row named
`testingmaxxiong`). The handler names the known types whenever a filtered query
comes back empty, so a typo cannot read as "Kalshi has no NFL players".

**`/milestones` requires `limit`** (a 400 without it) and its unfiltered page
skews heavily historical — pass `minimum_start_date` for current occurrences.

**`forecast_percentile_history` validates and then refuses.** Full evidence in
`docs/pack-build-queue.md`; do not re-probe it looking for the right parameters.

## Development

```bash
node scripts/sync-catalog.mjs          # after any tool change
pnpm check:examples                     # tool-examples.json must cover new tools
```

Smoke-test through the live gateway with the internal header, never with a BYO
key (`scripts/pwcall.sh call kalshi_weather_index '{"city":"nyc"}'`), and check
the payload is non-empty — a 200 with an empty array passes every CI gate and is
still a failed smoke test.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "kalshi": {
      "url": "https://gateway.pipeworx.io/kalshi/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/kalshi/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/kalshi_markets \
  -H 'Content-Type: application/json' \
  -d '{"keyword":"inflation"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/kalshi_markets`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "kalshi": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-kalshi"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-kalshi
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Kalshi data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
