# mcp-kalshi

Kalshi MCP — US-regulated prediction-market data (no auth on public reads).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `kalshi_markets` | List or search Kalshi prediction markets. Pass `keyword` to find markets by subject — "inflation", "Iran", "Vance" — served by Kalshi's own full-corpus search, with each result tagged match: market\|event\|related so you can tell a literal keyword hit from a relevance-ranked neighbor. Other filters: status (open\|closed\|settled), event_ticker (group by event), series_ticker (group by series like KXFED for Fed rate). Returns ticker, title, yes_ask/no_ask (in cents 1–99), volume, open_interest, and for a keyword search the event each market belongs to. Use this to discover markets; use kalshi_market for full detail. |
| `kalshi_market` | AUTHORITATIVE detail for one Kalshi market by ticker (e.g. "KXFED-26OCT-T3.50"). Returns the rules text (so you know exactly what the market settles on — critical before quoting odds), yes_ask + no_ask prices in cents, last_price, volume, open_interest, expiration date, settlement criteria. Use after kalshi_events / kalshi_event to drill into a specific market, or when you already have a Kalshi ticker. For depth-of-book use kalshi_orderbook. |
| `kalshi_events` | List/browse Kalshi events (event = a question with one-or-more child markets, e.g. "Fed funds rate after Oct 2026 meeting?" with 11 markets, one per rate bucket). Filter by status (open / settled), series_ticker (KXFED, KXBTC, KXCPI, etc.), or category. Use this as a discovery tool — to find what events Kalshi has open for a given topic family. For a specific event's child markets see kalshi_event; for one specific market see kalshi_market. |
| `kalshi_event` | AUTHORITATIVE odds from Kalshi — the only CFTC-regulated US prediction-market exchange (US persons CAN legally trade here, unlike Polymarket). Returns one event with ALL its child markets nested: event title + each market's ticker, subtitle, yes_ask price, volume. Use when you need the full partition for an outright bet ("Fed funds in June 2026: each rate level is one market"). Pass include_orderbook=true to fetch live top-of-book for each market (slower but populates yes_bid/yes_ask/no_bid/no_ask + implied_yes_prob — required for most macro events since the nested response leaves prices null on the public unauth API). For cross-venue spreads vs Polymarket, see polymarket_kalshi_spread. |
| `kalshi_series` | List Kalshi series (a series groups related events over time — e.g. "KXFED" series has one event per FOMC meeting). Useful to find the canonical handle for recurring questions. |
| `kalshi_orderbook` | Current YES/NO orderbook (bids + asks with size, in cents) for a market ticker. Use to see live liquidity depth before judging whether an edge is tradable. Returns sorted price/quantity levels. |
| `kalshi_trades` | Recent executed trades for a market ticker. Returns most-recent N trades with price (cents), size, side, timestamp. Useful for sanity-checking what the market is actually paying vs the resting orderbook. |
| `kalshi_price_history` | Historical price/probability time-series (candlesticks) for a Kalshi market — how the YES odds moved over time. Pass a market ticker (e.g. "KXFEDDECISION-28JAN-H26"). Returns OHLC candles: YES price (open/high/low/close/mean as probability 0-1), best bid/ask, volume, and open interest per interval. Use for "how has this market moved", trend/momentum, or charting a prediction over time. The Kalshi analogue of polymarket_price_history. Pick interval "1h" or "1d" (default) and lookback_days. |
| `kalshi_exchange_status` | Exchange-level status: is the trading floor open, are deposits/withdrawals enabled, any scheduled maintenance. Cheap check before a batch script. |
| `kalshi_macro` | Friendly-name shortcut for the most-asked Kalshi macro series: "Fed" (FOMC rate buckets), "BTC" (Bitcoin price ranges), "ETH" (Ethereum), "CPI" (monthly inflation), "GDP" (quarterly growth), "SP500" (S&P 500 EOY close), "Recession" (NBER recession calls). Returns the soonest-expiring open event for that series with all child markets + implied probabilities, so agents can ask about macro odds without knowing Kalshi's ticker scheme. |

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
