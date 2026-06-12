interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Kalshi MCP — US-regulated prediction-market data (no auth on public reads).
 *
 * Coverage: every open Kalshi market — politics, economics, Fed rates,
 * climate, sports, science, weather. Each Kalshi EVENT (e.g. "Fed funds
 * rate after Oct 2026 meeting?") groups multiple MARKETS (one per
 * outcome bucket), much like Polymarket's event → markets structure.
 *
 * All tools prefixed with `kalshi_` to dodge collisions with the
 * polymarket pack (which has similarly-named tools).
 *
 * Cross-market arb angle: when both Kalshi and Polymarket list the same
 * resolving event, their YES prices can disagree by several pp because
 * the two venues have different participant pools. Agents can use this
 * pack alongside `polymarket_*` to compute the spread.
 *
 * Docs: https://trading-api.readme.io/reference/getting-started
 */


const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = 'pipeworx-mcp-kalshi/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'kalshi_markets',
    description:
      'List/search Kalshi markets. Optional filters: status (open|closed|settled), event_ticker (group by event), series_ticker (group by series like KXFED for Fed rate). Returns ticker, title, yes_ask/no_ask (in cents 1–99), volume, open_interest. Use this to discover markets; use kalshi_market for full detail.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open | closed | settled (default open)' },
        event_ticker: { type: 'string', description: 'Filter to one event (e.g. "KXFED-26OCT")' },
        series_ticker: { type: 'string', description: 'Filter to one series (e.g. "KXFED" for Fed funds rate)' },
        limit: { type: 'number', description: '1-1000 (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor from previous response' },
      },
    },
  },
  {
    name: 'kalshi_market',
    description:
      'AUTHORITATIVE detail for one Kalshi market by ticker (e.g. "KXFED-26OCT-T3.50"). Returns the rules text (so you know exactly what the market settles on — critical before quoting odds), yes_ask + no_ask prices in cents, last_price, volume, open_interest, expiration date, settlement criteria. Use after kalshi_events / kalshi_event to drill into a specific market, or when you already have a Kalshi ticker. For depth-of-book use kalshi_orderbook.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Kalshi market ticker, e.g. "KXFED-26OCT-T3.50"' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'kalshi_events',
    description:
      'List/browse Kalshi events (event = a question with one-or-more child markets, e.g. "Fed funds rate after Oct 2026 meeting?" with 11 markets, one per rate bucket). Filter by status (open / settled), series_ticker (KXFED, KXBTC, KXCPI, etc.), or category. Use this as a discovery tool — to find what events Kalshi has open for a given topic family. For a specific event\'s child markets see kalshi_event; for one specific market see kalshi_market.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open | closed | settled (default open)' },
        series_ticker: { type: 'string', description: 'e.g. "KXFED"' },
        limit: { type: 'number', description: '1-200 (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
    },
  },
  {
    name: 'kalshi_event',
    description:
      'AUTHORITATIVE odds from Kalshi — the only CFTC-regulated US prediction-market exchange (US persons CAN legally trade here, unlike Polymarket). Returns one event with ALL its child markets nested: event title + each market\'s ticker, subtitle, yes_ask price, volume. Use when you need the full partition for an outright bet ("Fed funds in June 2026: each rate level is one market"). Pass include_orderbook=true to fetch live top-of-book for each market (slower but populates yes_bid/yes_ask/no_bid/no_ask + implied_yes_prob — required for most macro events since the nested response leaves prices null on the public unauth API). For cross-venue spreads vs Polymarket, see polymarket_kalshi_spread.',
    inputSchema: {
      type: 'object',
      properties: {
        event_ticker: { type: 'string', description: 'Kalshi event ticker, e.g. "KXFED-26OCT"' },
        include_orderbook: { type: 'boolean', description: 'Default false. When true, fetches per-market orderbook in parallel and patches in best bid/ask + recomputed implied_yes_prob. Adds ~1s for events with ~10 markets. Required when the nested response returns null prices (common for macro events on the unauth API).' },
      },
      required: ['event_ticker'],
    },
  },
  {
    name: 'kalshi_series',
    description:
      'List Kalshi series (a series groups related events over time — e.g. "KXFED" series has one event per FOMC meeting). Useful to find the canonical handle for recurring questions.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Politics | Economics | Climate | Sports | Science | World' },
        limit: { type: 'number', description: '1-1000 (default 200)' },
      },
    },
  },
  {
    name: 'kalshi_orderbook',
    description:
      'Current YES/NO orderbook (bids + asks with size, in cents) for a market ticker. Use to see live liquidity depth before judging whether an edge is tradable. Returns sorted price/quantity levels.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Kalshi market ticker' },
        depth: { type: 'number', description: 'Levels to return per side (default 5, max 100)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'kalshi_trades',
    description:
      'Recent executed trades for a market ticker. Returns most-recent N trades with price (cents), size, side, timestamp. Useful for sanity-checking what the market is actually paying vs the resting orderbook.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Kalshi market ticker' },
        limit: { type: 'number', description: '1-1000 (default 50)' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'kalshi_price_history',
    description:
      'Historical price/probability time-series (candlesticks) for a Kalshi market — how the YES odds moved over time. Pass a market ticker (e.g. "KXFEDDECISION-28JAN-H26"). Returns OHLC candles: YES price (open/high/low/close/mean as probability 0-1), best bid/ask, volume, and open interest per interval. Use for "how has this market moved", trend/momentum, or charting a prediction over time. The Kalshi analogue of polymarket_price_history. Pick interval "1h" or "1d" (default) and lookback_days.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Kalshi market ticker (e.g. "KXFEDDECISION-28JAN-H26"). The series is derived from the ticker automatically.' },
        interval: { type: 'string', description: '"1h" (hourly) | "1d" (daily, default) | "1m" (per-minute). Coarser intervals cover longer history.' },
        lookback_days: { type: 'number', description: 'How many days back to fetch (1-365, default 30).' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'kalshi_exchange_status',
    description:
      'Exchange-level status: is the trading floor open, are deposits/withdrawals enabled, any scheduled maintenance. Cheap check before a batch script.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kalshi_macro',
    description:
      'Friendly-name shortcut for the most-asked Kalshi macro series: "Fed" (FOMC rate buckets), "BTC" (Bitcoin price ranges), "ETH" (Ethereum), "CPI" (monthly inflation), "GDP" (quarterly growth), "SP500" (S&P 500 EOY close), "Recession" (NBER recession calls). Returns the soonest-expiring open event for that series with all child markets + implied probabilities, so agents can ask about macro odds without knowing Kalshi\'s ticker scheme.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Fed | BTC | ETH | CPI | GDP | SP500 | Recession' },
      },
      required: ['topic'],
    },
  },
];

// Friendly-name → Kalshi series-ticker map. Mirrors what NEXUS exposes
// as `get_kalshi_prediction_odds` so an agent that knows "Fed" doesn't
// need to know that the canonical Kalshi handle is "KXFED".
const MACRO_SERIES: Record<string, string> = {
  fed: 'KXFED',          // Fed funds rate after each FOMC meeting
  btc: 'KXBTC',          // Bitcoin price range (weekly)
  bitcoin: 'KXBTC',
  eth: 'KXETHY',         // ETH price EOY
  ethereum: 'KXETHY',
  cpi: 'KXCPI',          // CPI inflation (monthly)
  gdp: 'KXGDP',          // GDP growth (quarterly)
  sp500: 'KXSP500',      // S&P 500 EOY close
  recession: 'KXRECSS',  // NBER recession calls
};

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'kalshi_markets': {
      const params = new URLSearchParams();
      params.set('status', String(args.status ?? 'open'));
      params.set('limit', String(Math.min(1000, Math.max(1, (args.limit as number) ?? 100))));
      if (args.event_ticker) params.set('event_ticker', String(args.event_ticker));
      if (args.series_ticker) params.set('series_ticker', String(args.series_ticker));
      if (args.cursor) params.set('cursor', String(args.cursor));
      const data = (await kalshiGet(`/markets?${params}`)) as { markets?: KalshiMarket[]; cursor?: string };
      return {
        count: data.markets?.length ?? 0,
        cursor: data.cursor ?? null,
        markets: (data.markets ?? []).map((m) => formatMarket(m)),
      };
    }
    case 'kalshi_market': {
      const ticker = reqStr(args, 'ticker', '"KXFED-26OCT-T3.50"');
      const data = (await kalshiGet(`/markets/${encodeURIComponent(ticker)}`)) as { market?: KalshiMarket };
      if (!data.market) return { found: false, ticker };
      return { found: true, market: formatMarket(data.market, /* full */ true) };
    }
    case 'kalshi_events': {
      const params = new URLSearchParams();
      params.set('status', String(args.status ?? 'open'));
      params.set('limit', String(Math.min(200, Math.max(1, (args.limit as number) ?? 100))));
      if (args.series_ticker) params.set('series_ticker', String(args.series_ticker));
      if (args.cursor) params.set('cursor', String(args.cursor));
      const data = (await kalshiGet(`/events?${params}`)) as { events?: KalshiEvent[]; cursor?: string };
      return {
        count: data.events?.length ?? 0,
        cursor: data.cursor ?? null,
        events: (data.events ?? []).map(formatEvent),
      };
    }
    case 'kalshi_event': {
      const et = reqStr(args, 'event_ticker', '"KXFED-26OCT"');
      const includeOrderbook = args.include_orderbook === true;
      const data = (await kalshiGet(
        `/events/${encodeURIComponent(et)}?with_nested_markets=true`,
      )) as { event?: KalshiEvent & { markets?: KalshiMarket[] } };
      if (!data.event) return { found: false, event_ticker: et };
      let markets = data.event.markets ?? [];
      if (includeOrderbook && markets.length > 0) {
        // Augment each market with top-of-book derived from the live orderbook
        // endpoint. Kalshi's nested-markets response leaves prices null for
        // many macro events under the unauth API; the orderbook endpoint
        // does expose depth. Fetch in parallel — N small calls, capped at
        // 30 markets per event to bound latency.
        markets = await Promise.all(markets.slice(0, 30).map(enrichMarketWithOrderbook));
      }
      return {
        found: true,
        event: formatEvent(data.event),
        markets: markets.map((m) => formatMarket(m)),
      };
    }
    case 'kalshi_series': {
      const params = new URLSearchParams();
      params.set('limit', String(Math.min(1000, Math.max(1, (args.limit as number) ?? 200))));
      if (args.category) params.set('category', String(args.category));
      const data = (await kalshiGet(`/series?${params}`)) as { series?: Array<Record<string, unknown>> };
      return {
        count: data.series?.length ?? 0,
        series: (data.series ?? []).map((s) => ({
          ticker: s.ticker,
          title: s.title,
          category: s.category,
          frequency: s.frequency,
        })),
      };
    }
    case 'kalshi_orderbook': {
      const ticker = reqStr(args, 'ticker', '"KXFED-26OCT-T3.50"');
      const depth = Math.min(100, Math.max(1, (args.depth as number) ?? 5));
      const data = (await kalshiGet(
        `/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`,
      )) as { orderbook?: { yes?: number[][]; no?: number[][] } };
      const ob = data.orderbook ?? {};
      return {
        ticker,
        yes_bids: (ob.yes ?? []).map(([price, qty]) => ({ price_cents: price, quantity: qty })),
        no_bids: (ob.no ?? []).map(([price, qty]) => ({ price_cents: price, quantity: qty })),
        note: 'Kalshi quotes in cents (1-99). yes_bid X means someone will pay X cents for a YES contract that pays $1 on YES resolution. Implied YES probability = price_cents / 100.',
      };
    }
    case 'kalshi_trades': {
      const ticker = reqStr(args, 'ticker', '"KXFED-26OCT-T3.50"');
      const limit = Math.min(1000, Math.max(1, (args.limit as number) ?? 50));
      const data = (await kalshiGet(
        `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
      )) as { trades?: Array<Record<string, unknown>>; cursor?: string };
      return {
        ticker,
        count: data.trades?.length ?? 0,
        cursor: data.cursor ?? null,
        trades: (data.trades ?? []).map((t) => ({
          trade_id: t.trade_id,
          ticker: t.ticker,
          yes_price_cents: t.yes_price,
          no_price_cents: t.no_price,
          count: t.count,
          taker_side: t.taker_side,
          created_time: t.created_time,
        })),
      };
    }
    case 'kalshi_price_history': {
      const ticker = reqStr(args, 'ticker', '"KXFEDDECISION-28JAN-H26"');
      const interval = String(args.interval ?? '1d').toLowerCase();
      const PERIOD: Record<string, number> = { '1m': 1, '1min': 1, '1h': 60, '1hr': 60, '1d': 1440, '1day': 1440 };
      const period = PERIOD[interval] ?? 1440;
      const lookback = Math.min(365, Math.max(1, (args.lookback_days as number) ?? 30));
      // Series ticker is the first dash-segment of the market ticker
      // (KXFEDDECISION-28JAN-H26 → KXFEDDECISION). Required in the candlesticks path.
      const series = ticker.split('-')[0];
      const end = Math.floor(Date.now() / 1000);
      const start = end - lookback * 86_400;
      const data = (await kalshiGet(
        `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=${period}`,
      )) as { error?: string; message?: string; candlesticks?: Array<Record<string, unknown>> };
      if (data.error) return data;

      const num = (v: unknown): number | null => {
        const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
        return Number.isFinite(n) ? n : null;
      };
      const dollars = (obj: unknown, field: string): number | null =>
        num((obj as Record<string, unknown> | undefined)?.[field]);

      const candles = (data.candlesticks ?? []).map((c) => {
        const price = c.price as Record<string, unknown> | undefined;
        return {
          timestamp: c.end_period_ts ? new Date(Number(c.end_period_ts) * 1000).toISOString() : null,
          unix: c.end_period_ts ?? null,
          yes_open: dollars(price, 'open_dollars'),
          yes_high: dollars(price, 'high_dollars'),
          yes_low: dollars(price, 'low_dollars'),
          yes_close: dollars(price, 'close_dollars'),
          yes_mean: dollars(price, 'mean_dollars'),
          yes_bid_close: dollars(c.yes_bid, 'close_dollars'),
          yes_ask_close: dollars(c.yes_ask, 'close_dollars'),
          volume: num(c.volume_fp),
          open_interest: num(c.open_interest_fp),
        };
      });

      return {
        ticker,
        series,
        interval,
        period_minutes: period,
        lookback_days: lookback,
        point_count: candles.length,
        coverage: candles.length === 0
          ? 'no candles in window — market may be newly opened, illiquid, or have no trades in the lookback period (not a tool limit)'
          : `${candles.length} candle(s)`,
        candles,
      };
    }
    case 'kalshi_exchange_status': {
      const data = (await kalshiGet('/exchange/status')) as Record<string, unknown>;
      return data;
    }
    case 'kalshi_macro': {
      const topic = reqStr(args, 'topic', '"Fed"').toLowerCase();
      const series = MACRO_SERIES[topic];
      if (!series) {
        return {
          error: 'unknown_topic',
          topic,
          known_topics: Object.keys(MACRO_SERIES),
          message: `Unknown topic "${topic}". Use one of: ${Object.keys(MACRO_SERIES).join(', ')}. For arbitrary series, use kalshi_events with series_ticker.`,
        };
      }
      // Find the soonest-expiring open event for this series.
      const events = (await kalshiGet(`/events?series_ticker=${series}&status=open&limit=50`)) as { events?: KalshiEvent[] };
      const open = events.events ?? [];
      if (open.length === 0) {
        return { topic, series_ticker: series, found: false, message: `No open events for series ${series}.` };
      }
      // Sort by strike_date ascending (soonest first); fall back to first.
      open.sort((a, b) => (a.strike_date ?? 'z').localeCompare(b.strike_date ?? 'z'));
      const ev = open[0];
      // Pull that event's nested markets so the caller gets actionable prices in one call.
      const detail = (await kalshiGet(
        `/events/${encodeURIComponent(ev.event_ticker ?? '')}?with_nested_markets=true`,
      )) as { event?: KalshiEvent & { markets?: KalshiMarket[] } };
      const markets = (detail.event?.markets ?? []).map((m) => formatMarket(m));
      return {
        topic,
        series_ticker: series,
        event: formatEvent(detail.event ?? ev),
        markets,
        other_open_events: open.slice(1, 6).map(formatEvent),
        note: 'Returns the soonest-expiring open event for this series. Use other_open_events to drill into later periods, or kalshi_event with their event_ticker for full detail.',
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Raw types from Kalshi ────────────────────────────────────────────

interface KalshiMarket {
  ticker?: string;
  event_ticker?: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  yes_ask?: number;
  yes_bid?: number;
  no_ask?: number;
  no_bid?: number;
  last_price?: number;
  previous_yes_ask?: number;
  previous_yes_bid?: number;
  volume?: number;
  volume_24h?: number;
  liquidity?: number;
  open_interest?: number;
  expiration_time?: string;
  close_time?: string;
  open_time?: string;
  rules_primary?: string;
  rules_secondary?: string;
  category?: string;
}

interface KalshiEvent {
  event_ticker?: string;
  series_ticker?: string;
  title?: string;
  sub_title?: string;
  category?: string;
  mutually_exclusive?: boolean;
  strike_date?: string;
  strike_period?: string;
}

// ── Formatters ───────────────────────────────────────────────────────

// Trim a market down to the fields agents actually use; include rules text
// only on the full single-market lookup so list responses stay small.
function formatMarket(m: KalshiMarket, full = false): Record<string, unknown> {
  // Prefer the mid of bid/ask (real two-sided market). When only one side
  // is quoted, fall back to that side. When the orderbook is empty, use
  // last_price (the most recent trade). When even that's missing, infer
  // yes_prob from no_ask (1 - no/100). Empty orderbook is common on
  // forward-dated event markets (e.g., KXCPI-26NOV has 7 buckets with
  // no asks yet), and dropping them silently breaks downstream tools
  // like polymarket_kalshi_spread that filter on yes_prob != null.
  const impliedYesProb = computeImpliedYesProb(m);
  const base: Record<string, unknown> = {
    ticker: m.ticker ?? null,
    event_ticker: m.event_ticker ?? null,
    title: m.title ?? null,
    subtitle: m.subtitle ?? m.yes_sub_title ?? null,
    status: m.status ?? null,
    // Prices in cents on the wire; surface the implied probability too.
    yes_ask_cents: m.yes_ask ?? null,
    yes_bid_cents: m.yes_bid ?? null,
    no_ask_cents: m.no_ask ?? null,
    last_price_cents: m.last_price ?? null,
    implied_yes_prob: impliedYesProb,
    implied_yes_prob_source: impliedYesProbSource(m),
    volume: m.volume ?? null,
    volume_24h: m.volume_24h ?? null,
    open_interest: m.open_interest ?? null,
    close_time: m.close_time ?? m.expiration_time ?? null,
    category: m.category ?? null,
  };
  if (full) {
    base.rules_primary = m.rules_primary ?? null;
    base.rules_secondary = m.rules_secondary ?? null;
  }
  return base;
}

function computeImpliedYesProb(m: KalshiMarket): number | null {
  // Mid-price when both sides quoted
  if (typeof m.yes_ask === 'number' && typeof m.yes_bid === 'number') {
    return +(((m.yes_ask + m.yes_bid) / 2) / 100).toFixed(4);
  }
  if (typeof m.yes_ask === 'number') return +(m.yes_ask / 100).toFixed(4);
  if (typeof m.yes_bid === 'number') return +(m.yes_bid / 100).toFixed(4);
  if (typeof m.last_price === 'number') return +(m.last_price / 100).toFixed(4);
  // Infer from no_ask: if NO is offered at X cents, YES is implied at (100-X)
  if (typeof m.no_ask === 'number') return +((100 - m.no_ask) / 100).toFixed(4);
  return null;
}

function impliedYesProbSource(m: KalshiMarket): string | null {
  if (typeof m.yes_ask === 'number' && typeof m.yes_bid === 'number') return 'mid';
  if (typeof m.yes_ask === 'number') return 'yes_ask';
  if (typeof m.yes_bid === 'number') return 'yes_bid';
  if (typeof m.last_price === 'number') return 'last_price';
  if (typeof m.no_ask === 'number') return 'inferred_from_no_ask';
  return null;
}

// Patch a market with top-of-book derived from the /orderbook endpoint.
// Why this exists: Kalshi's /events/...?with_nested_markets=true endpoint
// returns null prices for most macro events on the unauth API right now,
// even though the /orderbook endpoint exposes a full depth ladder. The
// orderbook returns yes_dollars / no_dollars as [price_string, size_string]
// arrays sorted from low → high price. Best YES bid = highest yes_dollars
// price (most aggressive buyer of YES). Best YES ask = 1 − best NO bid
// (someone bidding 99¢ for NO implicitly offers YES at 1¢). Returns a
// shallow-merged copy of the input market with yes_ask/yes_bid/no_ask/
// no_bid populated where derivable; original fields preserved when set.
async function enrichMarketWithOrderbook(m: KalshiMarket): Promise<KalshiMarket> {
  if (!m.ticker) return m;
  // Don't re-fetch if we already have a top-of-book.
  if (typeof m.yes_ask === 'number' || typeof m.yes_bid === 'number') return m;
  try {
    const ob = await kalshiGet(`/markets/${encodeURIComponent(m.ticker)}/orderbook`) as {
      orderbook_fp?: { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> };
    };
    const yesLadder = ob.orderbook_fp?.yes_dollars ?? [];
    const noLadder = ob.orderbook_fp?.no_dollars ?? [];
    // yes_dollars sorted low→high; best YES bid is the top of book = last entry.
    const bestYesBid = yesLadder.length > 0 ? parseFloat(yesLadder[yesLadder.length - 1][0]) : null;
    const bestNoBid = noLadder.length > 0 ? parseFloat(noLadder[noLadder.length - 1][0]) : null;
    // YES ask = 1 - best NO bid; YES bid = best YES bid (direct).
    const yesBidCents = bestYesBid != null ? Math.round(bestYesBid * 100) : null;
    const yesAskCents = bestNoBid != null ? Math.round((1 - bestNoBid) * 100) : null;
    const noBidCents = bestNoBid != null ? Math.round(bestNoBid * 100) : null;
    const noAskCents = bestYesBid != null ? Math.round((1 - bestYesBid) * 100) : null;
    return {
      ...m,
      yes_bid: m.yes_bid ?? yesBidCents ?? undefined,
      yes_ask: m.yes_ask ?? yesAskCents ?? undefined,
      no_bid: m.no_bid ?? noBidCents ?? undefined,
      no_ask: m.no_ask ?? noAskCents ?? undefined,
    } as KalshiMarket;
  } catch {
    // Orderbook fetch failed — return the original market unchanged.
    return m;
  }
}

function formatEvent(e: KalshiEvent): Record<string, unknown> {
  return {
    event_ticker: e.event_ticker ?? null,
    series_ticker: e.series_ticker ?? null,
    title: e.title ?? null,
    sub_title: e.sub_title ?? null,
    category: e.category ?? null,
    mutually_exclusive: e.mutually_exclusive ?? null,
    strike_date: e.strike_date ?? null,
    strike_period: e.strike_period ?? null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

async function kalshiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
  });
  if (res.status === 404) {
    return { error: 'not_found', message: 'Kalshi: ticker not found.' };
  }
  if (res.status === 429) {
    throw new Error('Kalshi rate limit (HTTP 429). Try again in a minute.');
  }
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Kalshi: ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

function reqStr(args: Record<string, unknown>, key: string, example: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Required argument "${key}" is missing. Pass a string like ${example}.`);
  }
  return v.trim();
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
