interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Kalshi');
}

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const UA = 'pipeworx-mcp-kalshi/1.0 (+https://pipeworx.io)';

const tools: McpToolExport['tools'] = [
  {
    name: 'kalshi_markets',
    description:
      'List or search Kalshi prediction markets, open or already settled. Pass `keyword` to find markets by subject — "inflation", "Iran", "Vance" — served by Kalshi\'s own full-corpus search, with each result tagged match: market|event|related so you can tell a literal keyword hit from a relevance-ranked neighbor. A keyword search honours `status`, so status "settled" is how you find a RESOLVED market by subject (its `result` is the outcome) — Kalshi indexes settled markets separately and the open index does not contain them. Other filters: status (open|closed|settled|unopened), event_ticker (group by event), series_ticker (group by series like KXFED for Fed rate). EVERY path returns the same fields — ticker, event_ticker, series_ticker, title, subtitle, status, yes_ask/yes_bid/no_ask/last_price (cents 1–99), implied_yes_prob, volume, volume_24h, open_interest, liquidity, close_time, category, result — so you can screen by category AND liquidity in one call. Two fields are conditional and say so here rather than surprising you: `result` is the settled outcome ("yes"/"no") and is null while a market is still trading, and `category` comes from the market\'s Kalshi series (Kalshi\'s market records carry none), so it is null for the rare market whose series lookup fails — listed in fields_omitted when that happens. A keyword search adds two fields a listing has no notion of: event_title and match. Anything we cannot populate is named in `fields_omitted` rather than returned as a bare null. Use this to discover markets; use kalshi_market for the rules text.',
    summary: 'Kalshi prediction markets matching a filter, each with its live Yes/No price.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Subject to search for, e.g. "inflation", "Iran", "Vance". Runs Kalshi\'s own search over the full market corpus, in the slice named by `status` — pass status "settled" to find markets that have already RESOLVED (they carry `result`), which the default open index does not contain. Word-boundary matched, so "Vance" will not match "advance".' },
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
      'AUTHORITATIVE detail for one Kalshi market by ticker (e.g. "KXFED-26OCT-T3.50"), live OR long-settled — Kalshi drops older markets from its live endpoints (they 404 there), and this falls through to Kalshi\'s historical archive and says which answered in `source`. Returns the rules text (so you know exactly what the market settles on — critical before quoting odds), yes_ask + no_ask prices in cents, last_price, volume, open_interest, expiration date, settlement criteria. Use after kalshi_events / kalshi_event to drill into a specific market, or when you already have a Kalshi ticker. For depth-of-book use kalshi_orderbook.',
    summary: 'One Kalshi market in full, including the rules text that decides how it settles.',
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
      'List/browse Kalshi events (event = a question with one-or-more child markets, e.g. "Fed funds rate after Oct 2026 meeting?" with 11 markets, one per rate bucket). Filter by status (open / settled), series_ticker (KXFED, KXBTC, KXCPI, etc.), or category (Politics, Economics, Financials, Crypto, Climate and Weather, Sports, ...). Kalshi\'s own endpoint ignores a category filter, so we apply it over a bounded page scan and report events_scanned / scan_complete with the result — a category browse is filtered, not exhaustive. Use this as a discovery tool — to find what events Kalshi has open for a given topic family. For a specific event\'s child markets see kalshi_event; for one specific market see kalshi_market.',
    summary: 'Kalshi prediction market events matching a filter, each with its child markets, from Kalshi.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'open | closed | settled (default open)' },
        series_ticker: { type: 'string', description: 'e.g. "KXFED"' },
        category: { type: 'string', description: 'Kalshi category, exact words: Politics | Elections | Economics | Financials | Crypto | Companies | Commodities | Climate and Weather | Science and Technology | Sports | Entertainment | World | Health | Transportation | Social | Mentions | AI | Education | Business | Exotics. Applied by Pipeworx over a bounded scan of Kalshi\'s event pages (Kalshi\'s endpoint ignores category), so the response carries events_scanned and scan_complete.' },
        limit: { type: 'number', description: '1-200 (default 100)' },
        cursor: { type: 'string', description: 'Pagination cursor' },
      },
    },
  },
  {
    name: 'kalshi_event',
    description:
      'AUTHORITATIVE odds from Kalshi — the only CFTC-regulated US prediction-market exchange (US persons CAN legally trade here, unlike Polymarket). Returns one event with ALL its child markets nested: event title + each market\'s ticker, subtitle, price, volume. Use when you need the full partition for an outright bet ("Fed funds in June 2026: each rate level is one market"). Pass include_orderbook=true to fetch live top-of-book for each market (slower but populates yes_ask_cents/yes_bid_cents/no_ask_cents + implied_yes_prob — required for most macro events since the nested response leaves prices null on the public unauth API). Every price ships TWO ways: `*_cents` rounded to the nearest cent (Kalshi\'s display convention) and `*_dollars` at full fixed-point precision — a genuine sub-cent quote like 0.335 shows as 34 in `yes_ask_cents` and exactly 0.335 in `yes_ask_dollars`; use the dollars field for anything sizing a trade on a thin spread. `implied_yes_prob` is computed from the dollars value, not the rounded cents, so it carries the same precision. `yes_bid_size`/`no_bid_size` report top-of-book contract size for the two real resting sides when include_orderbook populated them from the orderbook ladder — there is no separate size for yes_ask/no_ask because those are derived prices (1 − the opposite side\'s best bid), not an independent order. For cross-venue spreads vs Polymarket, see polymarket_kalshi_spread.',
    summary: 'A Kalshi event with every child market and its current odds, from the regulated US exchange.',
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
    summary: 'A Kalshi market series — a recurring question type — and its markets, from Kalshi.',
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
    summary: 'The live bid and ask ladder for one Kalshi market, from Kalshi.',
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
      'Executed trades for a market ticker, live OR long-settled. Returns most-recent N trades with yes/no price in BOTH units (yes_price_cents and yes_price_dollars at full precision), contract size, taker side and timestamp. Useful for sanity-checking what the market actually paid vs the resting orderbook, and for reconstructing how a resolved market traded. Kalshi answers 200-with-an-empty-list on its live trades endpoint for markets it has archived, so this falls through to Kalshi\'s historical trade archive and reports which one answered in `source`.',
    summary: 'Trades recently executed on a Kalshi market, newest first, from Kalshi.',
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
      'Historical price/probability time-series (candlesticks) for a Kalshi market — how the YES odds moved over time, for ANY window, including one that ended long ago. Pass a market ticker (e.g. "KXFEDDECISION-28JAN-H26") plus either an explicit start_ts/end_ts window ("what did this market think in March?") or lookback_days as sugar for a window ending now. Returns OHLC candles: YES price (open/high/low/close/mean as probability 0-1), best bid/ask, volume, and open interest per interval. Kalshi serves at most 5,000 candles per request; a window larger than that comes back as page 1 with `next_cursor` and `complete: false` — pass the cursor straight back for the next slice, oldest-first — so a long window is never silently shortened. Kalshi also MOVES older markets out of its live endpoints, where they 404; this routes to Kalshi\'s historical archive automatically and reports which one answered in `source`, so backtesting a resolved 2024 market works the same way as charting a live one. The Kalshi analogue of polymarket_price_history.',
    summary: 'How a Kalshi market\'s Yes-price moved over time, as a timestamped series.',
    inputSchema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Kalshi market ticker (e.g. "KXFEDDECISION-28JAN-H26"). The series is derived from the ticker automatically. Required unless you are passing `cursor`.' },
        interval: { type: 'string', description: '"1h" (hourly) | "1d" (daily, default) | "1m" (per-minute). Coarser intervals cover longer history per request.' },
        lookback_days: { type: 'number', description: 'Sugar for a window length in days (1-365, default 30). Anchors to start_ts if you gave one, to end_ts if you gave that, and to now if you gave neither. Ignored when both start_ts and end_ts are set.' },
        start_ts: { type: 'string', description: 'Window START — ISO date ("2026-03-01"), ISO datetime ("2026-03-01T00:00:00Z"), or unix seconds. Use with end_ts to ask about a window that does NOT end today.' },
        end_ts: { type: 'string', description: 'Window END — same formats as start_ts. Defaults to now when omitted.' },
        cursor: { type: 'string', description: 'Pass back `next_cursor` from a previous response to fetch the next slice of a window too large for one request (>5,000 candles). The cursor carries the ticker, interval and remaining window, so no other argument is needed with it.' },
      },
    },
  },
  {
    name: 'kalshi_exchange_status',
    description:
      'Exchange-level status: is the trading floor open, are deposits/withdrawals enabled, any scheduled maintenance. Cheap check before a batch script.',
    summary: 'Whether the Kalshi exchange is currently open for trading, from Kalshi.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'kalshi_top_markets',
    description:
      'Ranking / leaderboard of Kalshi\'s most-traded markets right now — use this for "what is the highest volume prediction market on Kalshi", "most traded Kalshi market", or any top-N-by-activity question. Kalshi\'s /markets endpoint has NO server-side sort and its raw listing is 99%+ algorithmically-generated multivariate combo markets with zero volume, so paging through it would surface junk. This instead discovers real, currently-active markets via Kalshi\'s own search/relevance index, then re-ranks the leaders using each market\'s authoritative live volume/price detail. Returns title, ticker, event_ticker, volume, volume_24h, open_interest, liquidity, yes/no price (cents), close_time, as_of, and source, sorted highest-first. Not an exhaustive scan of every one of Kalshi\'s ~14,000 series — see `method` and `candidates_considered` in the response for the disclosed scan size.',
    summary: 'The highest-volume open Kalshi markets right now, from Kalshi.',
    inputSchema: {
      type: 'object',
      properties: {
        by: { type: 'string', description: 'volume (default, all-time contracts traded) | volume_24h | open_interest | liquidity' },
        limit: { type: 'number', description: '1-50 (default 10)' },
        status: { type: 'string', description: '"open" (default — only markets not yet past close_time) | "any" (include markets whose close_time has passed, still excludes settled/resulted ones)' },
      },
    },
  },
  {
    name: 'kalshi_macro',
    description:
      'Friendly-name shortcut for the most-asked Kalshi macro series: "Fed" (FOMC rate buckets), "BTC" (Bitcoin price ranges), "ETH" (Ethereum), "CPI" (monthly inflation), "GDP" (quarterly growth), "SP500" (S&P 500 EOY close), "Recession" (NBER recession calls). Returns the soonest-expiring open event for that series with all child markets + implied probabilities, so agents can ask about macro odds without knowing Kalshi\'s ticker scheme.',
    summary: 'Kalshi\'s macroeconomic indicator markets (CPI, Fed rate, jobs) and their live prices.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Fed | BTC | ETH | CPI | GDP | SP500 | Recession' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'kalshi_orderbooks',
    description:
      'Depth-of-book for UP TO 100 Kalshi markets in ONE call — Kalshi\'s own batch orderbook endpoint (`GET /markets/orderbooks`), not a fan-out we do for you. Use this instead of calling kalshi_orderbook once per ticker when you are pricing a whole event partition (an 11-bucket Fed event, a 20-strike temperature ladder) or screening several markets for liquidity: one request, one rate-limit slot. Returns per ticker: the full yes_bids / no_bids ladders (price in BOTH units — price_dollars at Kalshi\'s fixed-point precision and price_cents rounded — with quantity), plus best_yes_bid / best_no_bid and the derived yes_ask / no_ask (1 − the opposite side\'s best bid, which is what an ask IS in a binary market; Kalshi returns bids only). Kalshi returns an orderbook entry only for tickers it recognises AND that have a book, so any ticker you asked for that came back with nothing is named in `tickers_without_book` rather than silently dropped — an empty ladder is a real answer (nobody is quoting), not an error.',
    summary: 'Live bid/ask ladders for many Kalshi markets at once, from Kalshi\'s batch endpoint.',
    inputSchema: {
      type: 'object',
      properties: {
        tickers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Market tickers, 1-100 (Kalshi\'s own per-request cap, e.g. ["KXHIGHNY-26SEP16-B75.5","KXHIGHNY-26SEP16-B77.5"]). A comma-separated string is accepted too. More than 100 is an explicit error, not a silent truncation — page it yourself.',
        },
        depth: { type: 'number', description: 'Levels to keep per side, best-first (default 5, max 100). Kalshi returns the whole ladder; this trims the response. `levels_available` reports the untrimmed depth per side so you can tell a thin book from a trimmed one.' },
      },
      required: ['tickers'],
    },
  },
  {
    name: 'kalshi_candlesticks',
    description:
      'Price history (OHLC candles) for UP TO 100 Kalshi markets over ONE shared window, in ONE call — Kalshi\'s batch candlestick endpoint (`GET /markets/candlesticks`). This is the comparison tool: every bucket of a Fed or CPI event on one timeline, or the same question across several strikes, without the N separate calls kalshi_price_history would cost. Per candle: YES open/high/low/close/mean as a probability 0-1, best bid/ask close, volume and open interest. Kalshi caps the response at 10,000 candles ACROSS all markets combined — when the cap binds the response says `truncated_by_upstream: true` and tells you which tickers came back short, because a silently halved series is indistinguishable from a quiet market. For ONE ticker with paging, a longer window, or a market old enough that Kalshi has archived it, use kalshi_price_history: this batch endpoint has no archive fallback and no cursor.',
    summary: 'OHLC price history for many Kalshi markets on one shared timeline, from Kalshi.',
    inputSchema: {
      type: 'object',
      properties: {
        tickers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Market tickers, 1-100 (e.g. ["KXHIGHNY-26SEP16-B75.5","KXHIGHNY-26SEP16-B77.5"]). A comma-separated string is accepted too.',
        },
        interval: { type: 'string', description: '"1h" (hourly, default) | "1d" (daily) | "1m" (per-minute). Kalshi accepts only these three; the 10,000-candle cap is shared across every ticker you ask for, so a per-minute window over 100 markets will bind it.' },
        lookback_days: { type: 'number', description: 'Sugar for a window ending now (1-365, default 1). Ignored when both start_ts and end_ts are given.' },
        start_ts: { type: 'string', description: 'Window START — ISO date ("2026-09-01"), ISO datetime, or unix seconds.' },
        end_ts: { type: 'string', description: 'Window END — same formats. Defaults to now.' },
      },
      required: ['tickers'],
    },
  },
  {
    name: 'kalshi_event_live_data',
    description:
      'The REAL-WORLD measurement an event settles against, next to the odds — Kalshi\'s event live-data feed (`GET /live_data/events/{event_ticker}`). This is the thing you cannot get by calling any other Kalshi endpoint: for a crypto event it is the underlying BTC/ETH price track from the settlement index (candlesticks + tick timeseries); for an economic event it is the actual published series the market resolves on (e.g. CPI CUUR0000SA0 from BLS, monthly, with its latest value and the target period); for other events it is whatever observation Kalshi charts behind the contract. The response\'s `type` names the schema of `details` (seen live: "crypto", "timeseries"), and the fields that matter are lifted to the top level where they exist: latest_value, unit, measure, frequency, provider, series_id, target_period, last_refreshed. COVERAGE IS PARTIAL AND WE SAY SO: most events have no live data and answer 404 — this returns found:false with the ticker rather than an error. Weather is NOT here: temperature observations are city-keyed, not event-keyed (KXHIGHNY-26SEP16 404s) — use kalshi_weather_index. The raw payload can exceed 400 KB for an active crypto event, so series are trimmed to `max_points` newest-first and `points_total` reports what existed.',
    summary: 'The observed underlying data behind a Kalshi event — price track, published series — from Kalshi.',
    inputSchema: {
      type: 'object',
      properties: {
        event_ticker: { type: 'string', description: 'Kalshi event ticker, e.g. "KXBTCD-26SEP1617" (crypto) or "KXUSCPIYEAR-37FEB01" (economic series).' },
        range: { type: 'string', description: 'Chart-range hint passed straight to Kalshi, e.g. "15min", "1h", "1d". Honoured only by types that support it; the response reports Kalshi\'s own `default_range` and any `selectable_periods` it advertises.' },
        max_points: { type: 'number', description: 'Newest points to keep per series (default 200, max 2000). `points_total` always reports the untrimmed length.' },
      },
      required: ['event_ticker'],
    },
  },
  {
    name: 'kalshi_game_stats',
    description:
      'Live scoreboard and play-by-play for a sports game Kalshi has markets on, keyed by MILESTONE id (not event ticker) — Kalshi\'s `GET /live_data/milestone/{id}` plus `/game_stats`. Returns the current state (score, period/inning, status, last play, winner once final) and the play list, newest-first, each with its description, clock and score at the time. Get the milestone id from kalshi_milestones (its `related_event_tickers` is the bridge back to tradeable markets). COVERAGE, stated plainly: Kalshi documents play-by-play for Pro/College Football, Pro/College Basketball, WNBA, Soccer, Pro Hockey and Pro Baseball, and it comes from Sportradar — a milestone outside that set, or one Sportradar does not cover, returns HTTP 200 with an EMPTY play list, which this reports as plays_available:false rather than passing off an empty array as a game with no plays (verified live 2026-09-16: a college football game returned `{"pbp":{}}`).',
    summary: 'Live score and play-by-play for a Kalshi sports milestone, from Kalshi (Sportradar-fed).',
    inputSchema: {
      type: 'object',
      properties: {
        milestone_id: { type: 'string', description: 'Kalshi milestone UUID, e.g. "ce57e3ef-6b6a-4680-a849-5965021aaac2". Find one with kalshi_milestones(category:"Sports").' },
        limit: { type: 'number', description: 'Plays to return, newest first (default 25, max 500). `plays_total` reports how many existed.' },
      },
      required: ['milestone_id'],
    },
  },
  {
    name: 'kalshi_milestones',
    description:
      'Kalshi\'s own index of the real-world OCCURRENCES its markets hang off — games, elections, hearings, launches — from `GET /milestones`. Each milestone carries a title, type (e.g. baseball_game, football_game, tennis_tournament_singles, election), category, start and end dates, source ids, and — the reason to use this — `primary_event_tickers` and `related_event_tickers`, which are Kalshi\'s OWN statement of which markets belong to the occurrence. That is the alternative to matching event titles by string, which is how you accidentally group two different games. Filter by category ("Sports", "Elections", ...), type, competition, related_event_ticker (reverse lookup: which milestone is this event part of?) or minimum_start_date; page with cursor. A milestone id is also the key for kalshi_game_stats.',
    summary: 'Real-world occurrences Kalshi tracks — games, elections — and the events tied to each, from Kalshi.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Kalshi category, exact words, e.g. "Sports" | "Elections" | "Economics" | "Politics".' },
        type: { type: 'string', description: 'Milestone type, e.g. "baseball_game", "football_game", "basketball_game", "tennis_tournament_singles", "soccer_tournament_multi_leg".' },
        competition: { type: 'string', description: 'Competition filter, e.g. "NFL", "NBA" (Kalshi\'s own spelling; many milestones carry none).' },
        related_event_ticker: { type: 'string', description: 'Reverse lookup — return milestones linked to this event ticker.' },
        minimum_start_date: { type: 'string', description: 'RFC3339 timestamp; only milestones starting at or after it. Kalshi\'s default page is dominated by historical milestones, so pass this to see current ones.' },
        limit: { type: 'number', description: '1-200 (default 50). Kalshi requires this parameter; we always send it.' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
      },
    },
  },
  {
    name: 'kalshi_structured_targets',
    description:
      'The ENTITIES Kalshi\'s markets are about, as Kalshi models them — players, teams, actors, films and similar — from `GET /structured_targets`. Each row has a stable id, a type — granular by sport, e.g. "actor", "football_player", "soccer_team", "film", "company", "politician", with NO bare "player" or "team" and no error for an unknown one (it returns an empty list, and the response names the known types when that happens), a name, source ids, and a type-specific `details` block (a player carries league, position, jersey, team_id; an actor carries films and social handles). Use it to resolve a name to the id Kalshi itself uses, so a market about a person can be tied to that person rather than to a string that happens to match. Filter by type, competition, or explicit ids; page with cursor (up to 2,000 per page). This is a reference index, not market data — nothing here carries a price.',
    summary: 'Kalshi\'s entity index — players, teams, actors, films its markets reference — from Kalshi.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Entity type. Kalshi\'s types are GRANULAR BY SPORT and there is no bare "player", "team" or "athlete" — an unknown value returns 200 with an EMPTY list rather than an error. Seen live 2026-09-16: actor, album, baseball_player, baseball_team, basketball_player, basketball_team, company, couple, cricket_team, darts_competitor, esports_competitor, film, football_player, football_team, golf_competitor, hockey_player, politician, racing_competitor, soccer_player, soccer_team, song, table_tennis_competitor, tennis_competitor, tv_show, ufc_competitor, volleyball_team.' },
        competition: { type: 'string', description: 'Competition filter, e.g. "NFL", "NCAAMB". Same silent-empty behaviour as `type` for an unrecognised value.' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Explicit structured-target ids to fetch. A comma-separated string is accepted too.' },
        page_size: { type: 'number', description: '1-2000 (default 100).' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response.' },
      },
    },
  },
  {
    name: 'kalshi_weather_index',
    description:
      'Kalshi\'s OWN city temperature index — the minute-resolution series that its hourly temperature markets settle against, from `GET /live_data/weather/{city}`. This is not a weather forecast and not a single station: it is the number Kalshi computes from a weighted multi-station panel, in Fahrenheit to 0.01, which is the only series a temperature contract actually resolves on. Each point carries `contributors` (how many stations reported) and `status`; a minute where the quorum failed is reported rather than interpolated. CITY IS AN INDEX ID, NOT A PLACE NAME, and Kalshi supports exactly thirteen (verified live 2026-09-16 from Kalshi\'s own rejection message): miami, dfw, houston, phl-delaware-valley, puget-sound, sf-bay, greater-boston, southeast-michigan, kansas-city, minneapolis-st-paul, nyc, chicago, la-coastal. An unknown city is a clean error listing those. The series is city-keyed and independent of any event, so it exists even when no market is open. For the station weights and offsets behind the number, and every recalibration, use kalshi_weather_index_calibrations.',
    summary: 'The multi-station city temperature index Kalshi settles temperature markets on, from Kalshi.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Index city id — one of: miami, dfw, houston, phl-delaware-valley, puget-sound, sf-bay, greater-boston, southeast-michigan, kansas-city, minneapolis-st-paul, nyc, chicago, la-coastal.' },
        last_sec: { type: 'number', description: 'Window length ending now, in seconds (default 3600). The series is per-minute, so a window under ~120s can legitimately return zero points — that is a real empty window, not a failure, and `points` says 0.' },
        from: { type: 'number', description: 'Window start, unix MILLISECONDS (Kalshi\'s unit here, not seconds). Overrides last_sec when given with `to`.' },
        to: { type: 'number', description: 'Window end, unix MILLISECONDS, inclusive. Defaults to now.' },
        detailed: { type: 'boolean', description: 'Include Kalshi\'s per-station audit readings on every point (much larger response).' },
        max_points: { type: 'number', description: 'Newest points to keep (default 500, max 5000). `points_total` reports the untrimmed count.' },
      },
      required: ['city'],
    },
  },
  {
    name: 'kalshi_weather_index_calibrations',
    description:
      'How a Kalshi city temperature index is COMPUTED, and every time that changed — `GET /live_data/weather/{city}/calibrations`. Returns the launch configuration plus each weekly offset calibration and methodology update in ascending effective order: per-station weights, per-station offsets in Celsius, the city reference, the config version string, the calibration window and Kalshi\'s stated reason for the change. This is the audit trail behind kalshi_weather_index: it is what lets you reproduce an index value from raw station data, and what tells you whether a settlement dispute falls before or after a methodology change. Same thirteen city ids as kalshi_weather_index.',
    summary: 'Station weights, offsets and every recalibration behind a Kalshi city temperature index.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Index city id — miami, dfw, houston, phl-delaware-valley, puget-sound, sf-bay, greater-boston, southeast-michigan, kansas-city, minneapolis-st-paul, nyc, chicago, la-coastal.' },
      },
      required: ['city'],
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
  sp500: 'KXINX',        // S&P 500 range (KXSP500 has no active events — matches gateway KP_TOPIC_MAP)
  recession: 'KXRECSSNBER', // NBER recession calls (KXRECSS has no active events — matches gateway KP_TOPIC_MAP)
};


interface KalshiEventLite { event_ticker?: string; title?: string; sub_title?: string; series_ticker?: string }

// Word-START matching, not substring: "vance" as a substring matches the 100+
// sports "To Advance" series and buried real Vance markets under Brazilian
// election noise (answer-eval captures, fleet #401). A match must begin at a
// word boundary; suffixes still count so "iran" finds "Iranian".
function keywordRegex(keyword: string): RegExp {
  const esc = keyword.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}`, 'i');
}

/** Rows from Kalshi's own search API (the one behind kalshi.com's search box). */
interface KalshiSearchRow {
  series_ticker?: string;
  series_title?: string;
  event_ticker?: string;
  event_title?: string;
  event_subtitle?: string;
  category?: string;
  recent_volume?: number;
  markets?: Array<{
    ticker?: string;
    yes_subtitle?: string;
    no_subtitle?: string;
    title?: string;
    yes_bid?: number;
    yes_ask?: number;
    last_price?: number;
    volume?: number;
    close_ts?: string;
    result?: string;
  }>;
}

/**
 * Find markets by subject.
 *
 * Primary path: Kalshi's own search endpoint (/v1/search/series — undocumented
 * but it is what kalshi.com's search box calls), which relevance-ranks the FULL
 * corpus. The event-page scan below only reads the first ~2,000 events, which
 * refused "Iran" while 27 Iran series were live — a wrong refusal, disclosed or
 * not. Each returned event nests its live-priced markets, so no follow-up
 * market calls are needed.
 *
 * Kalshi's ranking is semantic (searching "Vance" ranks the 2028 election event
 * because a Vance market is inside it), so every market we return is tagged
 * with WHY it's here: match "market" (keyword hit on the market subtitle),
 * "event" (hit on the event/series title — the whole partition is on-topic),
 * or "related" (Kalshi's relevance only). Direct matches sort first, and
 * related rows are only used when direct matches leave room.
 */
/**
 * Our `status` → the one Kalshi's search index accepts. "active" is our alias
 * for "open"; "any" has no search-index equivalent and falls to the event scan.
 */
const SEARCH_API_STATUS: Record<string, string> = {
  open: 'open',
  active: 'open',
  closed: 'closed',
  settled: 'settled',
  unopened: 'unopened',
};

async function keywordSearch(keyword: string, args: Record<string, unknown>) {
  const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 100));
  const status = String(args.status ?? 'open');
  const re = keywordRegex(keyword);

  // Kalshi's search endpoint takes a `status` (verified 2026-09-15: open |
  // closed | settled | unopened; anything else is a 400), and the settled slice
  // is a DIFFERENT index — `2024 presidential election` with status=settled
  // returns the retired `PRES` series, which the default (open) search does not
  // carry at all. This used to send only open searches to the index and drop
  // every settled/closed keyword hunt into the bounded event scan, so a caller
  // asking for a search got a sample of open events instead — a wrong answer
  // wearing a right one's shape. Unknown statuses still fall through to the scan.
  const searchStatus = SEARCH_API_STATUS[status];
  if (searchStatus) {
    try {
      const data = (await kalshiGet(
        `https://api.elections.kalshi.com/v1/search/series?query=${encodeURIComponent(keyword)}&page_size=25&status=${searchStatus}`,
      )) as { total_results_count?: number; current_page?: KalshiSearchRow[]; error?: string };
      if (!data.error && Array.isArray(data.current_page)) {
        return await searchApiResult(keyword, re, data.current_page, data.total_results_count ?? 0, limit, searchStatus);
      }
    } catch {
      // fall through to the event scan
    }
  }
  return eventScanSearch(keyword, re, status, limit);
}

interface SearchPick {
  m: NonNullable<KalshiSearchRow['markets']>[number];
  row: KalshiSearchRow;
  match: 'market' | 'event' | 'related';
}

async function searchApiResult(
  keyword: string,
  re: RegExp,
  rows: KalshiSearchRow[],
  total: number,
  limit: number,
  searchStatus: string,
) {
  const direct: SearchPick[] = [];
  const related: SearchPick[] = [];
  for (const row of rows) {
    const eventHit = re.test(`${row.series_title ?? ''} ${row.event_title ?? ''} ${row.event_subtitle ?? ''}`);
    const all = row.markets ?? [];
    const marketHits = all.filter((m) => re.test(`${m.yes_subtitle ?? ''} ${m.title ?? ''}`));
    // Keyword on a market → just those markets (the Vance row of a 30-candidate
    // event, not all 30). Keyword on the event → the partition is the answer,
    // capped. Neither → Kalshi relevance only, one market as a pointer.
    const chosen = marketHits.length ? marketHits : eventHit ? all.slice(0, 10) : all.slice(0, 1);
    const matchBasis: SearchPick['match'] = marketHits.length ? 'market' : eventHit ? 'event' : 'related';
    for (const m of chosen) {
      (matchBasis === 'related' ? related : direct).push({ m, row, match: matchBasis });
    }
  }
  const picks = [...direct, ...related.slice(0, Math.max(0, limit - direct.length))].slice(0, limit);

  if (!picks.length) {
    return {
      found: false,
      reason: 'no_market_matched_keyword',
      keyword,
      source: 'kalshi_search_api',
      searched_status: searchStatus,
      total_results_count: total,
      hint: `Kalshi's search has no ${searchStatus} market for "${keyword}". Try a broader word, a different status (open | settled | closed — "settled" is where a market that has already resolved lives), kalshi_events to browse, or kalshi_macro for the standing macro series (fed, cpi, btc, gdp, sp500, recession).`,
    };
  }
  // Kalshi's search endpoint returns only a price-and-subtitle sketch of each
  // market — no title, status, no_ask, volume_24h, open_interest, liquidity or
  // result. Left as-is those came back null on EVERY keyword search while the
  // plain listing had them, so a caller could have a market's category or its
  // liquidity and never both, and a category-filtered liquidity screener was
  // unbuildable on this tool (fleet #2037). One batched /markets?tickers= call
  // closes the gap; the search row still supplies category and event_title,
  // which /markets does not carry.
  const full = await marketsByTicker(picks.map((p) => p.m.ticker));
  await resolveSeriesCategories(
    picks.map((p) => p.row.series_ticker ?? seriesTickerOf(p.row.event_ticker)),
  );

  const unenriched: string[] = [];
  const markets = picks.map((p) => {
    const authoritative = p.m.ticker ? full.get(p.m.ticker) : undefined;
    if (!authoritative && p.m.ticker) unenriched.push(p.m.ticker);
    const base: KalshiMarket = authoritative
      ? { ...authoritative, event_ticker: authoritative.event_ticker ?? p.row.event_ticker }
      : {
          // Fallback: the market is in the search index but the markets
          // endpoint would not return it (delisted mid-call, or upstream
          // error). Keep the sketch rather than dropping the row, and say so.
          ticker: p.m.ticker,
          event_ticker: p.row.event_ticker,
          subtitle: p.m.yes_subtitle || p.m.title || undefined,
          yes_bid: p.m.yes_bid,
          yes_ask: p.m.yes_ask,
          last_price: p.m.last_price,
          volume_fp: p.m.volume,
          close_time: p.m.close_ts,
        };
    return {
      ...formatMarket({
        ...base,
        series_ticker: p.row.series_ticker ?? base.series_ticker,
        category: p.row.category || base.category,
      }),
      event_title: p.row.event_title ?? null,
      match: p.match,
    };
  });

  return {
    found: true,
    keyword,
    count: markets.length,
    source: 'kalshi_search_api',
    // Which slice of Kalshi's index answered. status "settled" reaches markets
    // that have already resolved (and carry `result`); the default "open" index
    // does not contain them at all.
    searched_status: searchStatus,
    total_results_count: total,
    direct_matches: direct.length,
    markets,
    fields: MARKET_FIELDS,
    // Named, not silent: these two exist only because a keyword search knows
    // WHY a market is in the answer. The list path has no such notion.
    keyword_only_fields: ['event_title', 'match'],
    ...(unenriched.length
      ? {
          fields_omitted: ['title', 'status', 'no_ask_cents', 'volume_24h', 'open_interest', 'liquidity', 'result'],
          fields_omitted_for: unenriched,
          fields_omitted_reason:
            'Kalshi\'s search index listed these tickers but /markets?tickers= did not return them, so only the search sketch (price, subtitle, volume) is available for those rows.',
        }
      : {}),
    note: 'match: "market" = keyword on the market itself, "event" = keyword on its event/series title, "related" = Kalshi relevance ranking only. Direct matches sort first. Every row carries the same fields as a plain kalshi_markets listing (see `fields`), enriched from /markets.',
  };
}

/**
 * Fallback: scan event pages. Bounded on purpose — Kalshi has thousands of
 * open events, so this reads a fixed number of pages and SAYS how many it read.
 * A silent partial scan would be the same class of bug this replaces.
 */
async function eventScanSearch(keyword: string, re: RegExp, status: string, limit: number) {
  const MAX_EVENT_PAGES = 10;
  const PAGE = 200;

  const matched: KalshiEventLite[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  let exhausted = false;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const q = new URLSearchParams({ status, limit: String(PAGE) });
    if (cursor) q.set('cursor', cursor);
    const data = (await kalshiGet(`/events?${q}`)) as { events?: KalshiEventLite[]; cursor?: string };
    const events = data.events ?? [];
    scanned += events.length;
    for (const e of events) {
      if (re.test(`${e.title ?? ''} ${e.sub_title ?? ''} ${e.series_ticker ?? ''}`)) matched.push(e);
    }
    cursor = data.cursor ?? undefined;
    if (!cursor || !events.length) { exhausted = true; break; }
  }

  if (!matched.length) {
    return {
      found: false,
      reason: 'no_event_matched_keyword',
      keyword,
      events_scanned: scanned,
      scan_complete: exhausted,
      hint: `No open Kalshi event mentions "${keyword}". Kalshi groups markets under events, and the subject lives on the event title — try a broader word, or kalshi_macro for the standing macro series (fed, cpi, btc, gdp, sp500, recession).`,
    };
  }

  // Markets for the matched events, newest-matching first, bounded by `limit`.
  // Warm the series→category cache first so this path returns category too —
  // /markets never carries it (fleet #2037).
  await resolveSeriesCategories(matched.map((e) => e.series_ticker ?? seriesTickerOf(e.event_ticker)));
  const markets: unknown[] = [];
  const usedEvents: string[] = [];
  for (const e of matched) {
    if (markets.length >= limit || !e.event_ticker) break;
    const q = new URLSearchParams({ status, limit: String(Math.min(1000, limit)), event_ticker: e.event_ticker });
    const data = (await kalshiGet(`/markets?${q}`)) as { markets?: KalshiMarket[] };
    for (const m of data.markets ?? []) {
      if (markets.length >= limit) break;
      markets.push({
        ...formatMarket({ ...m, event_ticker: m.event_ticker ?? e.event_ticker, series_ticker: m.series_ticker ?? e.series_ticker }),
        event_title: e.title ?? null,
        match: 'event' as const,
      });
    }
    usedEvents.push(e.event_ticker);
  }

  return {
    found: markets.length > 0,
    keyword,
    count: markets.length,
    matched_events: matched.length,
    events_used: usedEvents,
    // Say what was read. A bounded search that does not disclose its bound is
    // indistinguishable from a complete one.
    events_scanned: scanned,
    scan_complete: exhausted,
    markets,
    fields: MARKET_FIELDS,
    keyword_only_fields: ['event_title', 'match'],
  };
}

const TOP_MARKETS_SORT_FIELDS = ['volume', 'volume_24h', 'open_interest', 'liquidity'] as const;

/**
 * Rank Kalshi markets by trading activity. Kalshi's own /markets endpoint has
 * no sort param (verified: `sort=`/`order_by=` are silently ignored) and its
 * unscoped listing is dominated by algorithmically-generated multivariate
 * combo markets — a 60,000-market page-scan turned up ZERO non-combo markets
 * with nonzero volume (verified 2026-09-03). Real high-volume markets (a Fed
 * decision, a Presidential-nominee future, a live sports game) simply aren't
 * reachable by paging the default listing in any bounded number of pages.
 *
 * Instead this discovers candidates via Kalshi's own search index (the same
 * endpoint keywordSearch uses, called here with an EMPTY query — verified to
 * surface genuinely high-volume real markets that plain pagination misses
 * entirely: election futures, Fed decisions, live sporting events). That
 * index's own `volume` figure is a coarser/different count than the trade
 * API's, so it's used ONLY to pick candidates; the numbers actually returned
 * come from each candidate's authoritative /markets/{ticker} detail call.
 */
async function findTopMarkets(args: Record<string, unknown>) {
  const byRaw = typeof args.by === 'string' ? args.by : 'volume';
  const by = (TOP_MARKETS_SORT_FIELDS as readonly string[]).includes(byRaw) ? byRaw : 'volume';
  const limit = Math.min(50, Math.max(1, Math.floor((args.limit as number) ?? 10)));
  const status = String(args.status ?? 'open');

  const searchData = (await kalshiGet(
    'https://api.elections.kalshi.com/v1/search/series?query=&page_size=200',
  )) as { current_page?: KalshiSearchRow[]; error?: string };
  const rows = searchData.current_page ?? [];

  const now = Date.now();
  const seen = new Set<string>();
  const candidates: Array<{ ticker: string; poolVolume: number }> = [];
  for (const row of rows) {
    for (const m of row.markets ?? []) {
      if (!m.ticker || seen.has(m.ticker)) continue;
      if (m.result) continue; // already settled — not a "right now" market
      if (status === 'open') {
        const closeMs = m.close_ts ? Date.parse(m.close_ts) : NaN;
        if (Number.isFinite(closeMs) && closeMs < now) continue;
      }
      seen.add(m.ticker);
      candidates.push({ ticker: m.ticker, poolVolume: m.volume ?? 0 });
    }
  }
  candidates.sort((a, b) => b.poolVolume - a.poolVolume);

  if (!candidates.length) {
    return {
      found: false,
      sort_by: by,
      status,
      candidates_considered: 0,
      hint: 'No candidates found in Kalshi\'s search index for this status filter. Try status "any", or kalshi_markets/kalshi_events to browse directly.',
    };
  }

  // For volume (the index's own primary signal), only the requested top-N need
  // authoritative enrichment. For the other fields the pool's volume-ranking
  // is just a proxy for "currently active", so widen the enrichment window to
  // re-rank a larger, still-bounded slice by the field actually requested.
  const enrichCap = by === 'volume' ? limit : Math.min(60, candidates.length);
  const toEnrich = candidates.slice(0, Math.min(enrichCap, candidates.length));

  const enriched = await Promise.all(
    toEnrich.map(async (c) => {
      const data = (await kalshiGet(`/markets/${encodeURIComponent(c.ticker)}`)) as { market?: KalshiMarket };
      return data.market ? formatMarket(data.market) : null;
    }),
  );
  const valid = enriched.filter((m): m is Record<string, unknown> => m !== null);
  valid.sort((a, b) => (Number(b[by]) || 0) - (Number(a[by]) || 0));
  const markets = valid.slice(0, limit);

  return {
    found: markets.length > 0,
    sort_by: by,
    order: 'desc',
    status,
    count: markets.length,
    candidates_considered: candidates.length,
    enriched_count: valid.length,
    markets,
    as_of: new Date().toISOString(),
    source: 'kalshi',
    method: `Discovered ${candidates.length} candidate market(s) via Kalshi's own search/relevance index (not an exhaustive scan of every open market — Kalshi's raw /markets listing has no volume sort and is 99%+ synthetic multivariate combo markets), enriched the top ${valid.length} with live /markets/{ticker} detail, and sorted by ${by} desc.`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Gateway injects _proxyUrl/_proxyToken when a non-CF egress relay is set
  // (Kalshi filters Cloudflare IPs on its listing endpoints). See kalshiGet.
  PROXY = (args._proxyUrl && args._proxyToken)
    ? { url: String(args._proxyUrl), token: String(args._proxyToken) }
    : null;
  switch (name) {
    case 'kalshi_markets': {
      // `keyword` was accepted by callers and by the router but declared
      // nowhere and read nowhere, so it was dropped and every search returned
      // the same unfiltered open-markets page — two different keywords produced
      // BYTE-IDENTICAL payloads of baseball markets, booking as a success.
      //
      // Kalshi's /markets endpoint has no text search at all (search=, query=
      // and q= are ignored upstream, verified), and market titles do not carry
      // the subject anyway: 12,000 open markets contain the word "inflation"
      // zero times, because those markets are titled by index level. The
      // subject lives on the EVENT — "US headline CPI inflation in December
      // 2036" — so a keyword resolves through events and returns their markets.
      if (typeof args.keyword === 'string' && args.keyword.trim()) {
        return keywordSearch(args.keyword.trim(), args);
      }
      const params = new URLSearchParams();
      params.set('status', String(args.status ?? 'open'));
      params.set('limit', String(Math.min(1000, Math.max(1, (args.limit as number) ?? 100))));
      if (args.event_ticker) params.set('event_ticker', String(args.event_ticker));
      if (args.series_ticker) params.set('series_ticker', String(args.series_ticker));
      if (args.cursor) params.set('cursor', String(args.cursor));
      // Kalshi INTERMITTENTLY returns 200-with-[] for the UNSCOPED /markets listing
      // from datacenter/Cloudflare IPs (one call empty, the next full — same soft
      // anti-bot filtering that gates the unscoped /events browse). Scoped
      // (event_ticker/series_ticker), cursor-paged, and detail calls egress fine,
      // so only retry the unscoped first page; a couple of retries reliably lands
      // data instead of surfacing a false count:0.
      const unscoped = !args.event_ticker && !args.series_ticker && !args.cursor;
      let data = (await kalshiGet(`/markets?${params}`)) as { markets?: KalshiMarket[]; cursor?: string };
      for (let attempt = 0; unscoped && !(data.markets && data.markets.length) && attempt < 3; attempt++) {
        data = (await kalshiGet(`/markets?${params}`)) as { markets?: KalshiMarket[]; cursor?: string };
      }
      const rows = data.markets ?? [];
      // /markets has no category field, so resolve it from each market's
      // series before formatting. Bounded and cached; whatever the budget
      // could not reach is named rather than left as a silent null.
      const unresolved = await resolveSeriesCategories(rows.map((m) => seriesTickerOf(m.event_ticker)));
      return {
        count: rows.length,
        cursor: data.cursor ?? null,
        markets: rows.map((m) => formatMarket(m)),
        fields: MARKET_FIELDS,
        ...(unresolved.length
          ? {
              fields_omitted: ['category'],
              fields_omitted_for_series: unresolved,
              fields_omitted_reason: `category is resolved one Kalshi series at a time and this page spans more than ${SERIES_LOOKUP_BUDGET} series; markets in the series listed above report category null. Narrow with series_ticker or event_ticker, or lower limit.`,
            }
          : {}),
      };
    }
    case 'kalshi_market': {
      const ticker = reqStr(args, 'ticker', '"KXFED-26OCT-T3.50"');
      const data = (await kalshiGet(`/markets/${encodeURIComponent(ticker)}`)) as { market?: KalshiMarket };
      let market = data.market ?? null;
      let source: 'live' | 'archive' = 'live';
      if (!market) {
        // Kalshi 404s the live detail path for a market it has archived, so an
        // old-but-real ticker read as "no such market". Match the ticker back
        // explicitly: `/historical/markets` IGNORES a singular `ticker=` param
        // and would otherwise hand us an unrelated market as an answer.
        const arch = (await kalshiGet(
          `${ARCHIVE_BASE}/markets?tickers=${encodeURIComponent(ticker)}&limit=1`,
        )) as { markets?: KalshiMarket[] };
        const hit = (arch.markets ?? []).find((m) => (m.ticker ?? '').toUpperCase() === ticker.toUpperCase());
        if (hit) {
          market = hit;
          source = 'archive';
        }
      }
      if (!market) {
        return {
          found: false,
          ticker,
          searched: ['live /markets/{ticker}', 'archive /historical/markets?tickers='],
          hint: 'Call kalshi_markets to find a valid ticker (pass status "settled" for a market that has already resolved, or kalshi_events/kalshi_event to browse by event).',
        };
      }
      return {
        found: true,
        source,
        ...(source === 'archive'
          ? { source_note: 'Kalshi has moved this market out of its live endpoints; served from /historical/markets, where the settled `result` is authoritative.' }
          : {}),
        market: formatMarket(market, /* full */ true),
      };
    }
    case 'kalshi_events': {
      const status = String(args.status ?? 'open');
      const limit = Math.min(200, Math.max(1, (args.limit as number) ?? 100));
      // The description has advertised a category filter since this tool
      // shipped and there was no such parameter, so every "category-filtered"
      // browse silently returned the full unfiltered list (fleet #2037).
      // Kalshi's /events endpoint ignores category= upstream — verified
      // 2026-09-15, /events?status=open&limit=5 and the same URL with
      // &category=Economics return the identical five rows, none of them
      // Economics — so the filter is ours, applied over a bounded page scan
      // that says how far it read.
      const category = typeof args.category === 'string' && args.category.trim()
        ? args.category.trim()
        : null;
      const wanted = category?.toLowerCase();
      const matchesCategory = (e: KalshiEvent) =>
        !wanted || (e.category ?? '').toLowerCase() === wanted;

      // Measured 2026-09-15: Kalshi's whole open-event universe is 3,600 events,
      // and they are NOT ordered by category — the single open Crypto event sat
      // at position 2,400. A 10-page (2,000-event) bound therefore returned a
      // clean, disclosed zero for a category that exists, which is the same
      // silent shape this task is about. 20 pages covers 4,000 > 3,600, so the
      // scan is exhaustive today and scan_complete says so truthfully instead of
      // always hedging. The loop still stops the moment `limit` is met, so a
      // common category (Economics, Sports) still costs exactly one page.
      const MAX_CATEGORY_PAGES = 20;
      const PAGE = category ? 200 : limit;
      const collected: KalshiEvent[] = [];
      let upstreamError: { error: string; message?: string } | null = null;
      let scanned = 0;
      let pageCursor = args.cursor ? String(args.cursor) : undefined;
      let lastCursor: string | null = null;
      let scanComplete = false;
      for (let page = 0; page < (category ? MAX_CATEGORY_PAGES : 1); page++) {
        const params = new URLSearchParams();
        params.set('status', status);
        params.set('limit', String(PAGE));
        if (args.series_ticker) params.set('series_ticker', String(args.series_ticker));
        if (pageCursor) params.set('cursor', pageCursor);
        const page_data = (await kalshiGet(`/events?${params}`)) as {
          events?: KalshiEvent[]; cursor?: string; error?: string; message?: string;
        };
        // A soft upstream failure (429 above all — a deep category scan is ~18
        // sequential pages and Kalshi rate-limits) arrives as an object with no
        // `events`. Left unrecorded it reads as an empty page, and an empty
        // page reads as "this category does not exist" — a confident wrong
        // answer where the truth is "we were not allowed to look".
        if (page_data.error) { upstreamError = { error: page_data.error, message: page_data.message }; break; }
        const batch = page_data.events ?? [];
        scanned += batch.length;
        for (const e of batch) if (matchesCategory(e)) collected.push(e);
        lastCursor = page_data.cursor ?? null;
        pageCursor = page_data.cursor ?? undefined;
        if (!pageCursor || !batch.length) { scanComplete = true; break; }
        if (collected.length >= limit) break;
      }
      const data = { cursor: lastCursor };
      const events = collected.slice(0, limit);

      // CF-egress workaround: Kalshi filters the UNSCOPED /events listing for
      // datacenter IPs (returns 200 with []), while /markets?status=, /series,
      // and scoped /events?series_ticker= all egress fine. When an unscoped
      // browse comes back empty, rebuild the event list from open markets
      // grouped by event_ticker so discovery still works through the gateway.
      // Scoped + detail + cursor-paged calls never reach this path, so working
      // behavior is untouched. (event_ticker = `{SERIES}-{strike}`, so the
      // prefix before the first '-' is the series_ticker.)
      if (!events.length && !scanned && !args.series_ticker && !args.cursor) {
        const mk = (await kalshiGet(
          `/markets?status=${encodeURIComponent(status)}&limit=200`,
        )) as { markets?: KalshiMarket[] };
        const byEvent = new Map<string, { event_ticker: string; series_ticker: string; markets_count: number }>();
        for (const m of mk.markets ?? []) {
          const et = m.event_ticker;
          if (!et) continue;
          const existing = byEvent.get(et);
          if (existing) existing.markets_count++;
          else byEvent.set(et, { event_ticker: et, series_ticker: et.split('-')[0], markets_count: 1 });
        }
        // Category is resolvable here too — it lives on the series, which the
        // event_ticker prefix names. So a category filter still works on this
        // fallback instead of quietly matching nothing.
        await resolveSeriesCategories(Array.from(byEvent.values()).map((e) => e.series_ticker));
        const derived = Array.from(byEvent.values())
          .map((e) => ({ ...e, category: SERIES_CATEGORY.get(e.series_ticker) ?? null }))
          .filter((e) => !wanted || (e.category ?? '').toLowerCase() === wanted)
          .sort((a, b) => b.markets_count - a.markets_count)
          .slice(0, limit);
        if (derived.length) {
          return {
            count: derived.length,
            cursor: null,
            ...(category ? { category, category_filter: 'applied_by_pipeworx' } : {}),
            events: derived.map((e) => ({
              event_ticker: e.event_ticker,
              series_ticker: e.series_ticker,
              title: null,
              sub_title: null,
              category: e.category,
              markets_count: e.markets_count,
            })),
            _note: 'Derived from open markets — Kalshi blocks the unscoped events listing from datacenter IPs. Titles are omitted here (category is resolved from each event\'s Kalshi series); pass series_ticker to this tool for full event metadata, or kalshi_event for a single event.',
          };
        }
      }

      if (upstreamError && !events.length) {
        // Say we could not look, rather than that there was nothing to find.
        return {
          count: 0,
          events: [],
          ...(category ? { category, category_filter: 'applied_by_pipeworx' } : {}),
          events_scanned: scanned,
          scan_complete: false,
          error: upstreamError.error,
          message: upstreamError.message,
          hint: `Kalshi did not serve the event listing (${upstreamError.error}), so this is NOT a statement that no such event exists. A category browse pages through Kalshi's whole open-event list and can hit its rate limit; retry in a minute, or pass series_ticker to scope the call to one series.`,
        };
      }

      if (category && !events.length) {
        return {
          count: 0,
          cursor: data.cursor ?? null,
          category,
          category_filter: 'applied_by_pipeworx',
          events: [],
          events_scanned: scanned,
          scan_complete: scanComplete,
          hint: `No ${status} Kalshi event in the first ${scanned} scanned carries category "${category}". Kalshi's own categories are: Politics, Elections, Economics, Financials, Crypto, Companies, Commodities, Climate and Weather, Science and Technology, Sports, Entertainment, World, Health, Transportation, Social, Mentions, AI, Education, Business, Exotics. Categories are case-sensitive words, not free text.`,
        };
      }

      return {
        count: events.length,
        cursor: data.cursor ?? null,
        ...(category
          ? {
              category,
              // Say who did the filtering. Kalshi's endpoint ignores category=,
              // so this is our scan, and a bounded scan that does not disclose
              // its bound is indistinguishable from a complete one.
              category_filter: 'applied_by_pipeworx',
              events_scanned: scanned,
              scan_complete: scanComplete,
            }
          : {}),
        events: events.map(formatEvent),
      };
    }
    case 'kalshi_event': {
      const et = reqStr(args, 'event_ticker', '"KXFED-26OCT"');
      const includeOrderbook = args.include_orderbook === true;
      // Kalshi's batch orderbook endpoint takes 100 tickers per request, so the
      // old fan-out (one call per market, Promise.all capped at 30) is gone:
      // it cost N rate-limit slots AND silently dropped the 31st child market
      // of any larger event. `orderbook_limit` is still honoured when a caller
      // deliberately wants a cheap probe rather than the whole partition.
      const obLimit = typeof args.orderbook_limit === 'number'
        ? Math.max(1, Math.floor(args.orderbook_limit))
        : Infinity;
      const data = (await kalshiGet(
        `/events/${encodeURIComponent(et)}?with_nested_markets=true`,
      )) as { event?: KalshiEvent & { markets?: KalshiMarket[] }; error?: string; message?: string };
      // Propagate a soft upstream error (e.g. rate_limited) so the reason
      // survives to the caller instead of looking like an empty event.
      if (data.error) return { found: false, event_ticker: et, error: data.error, message: data.message };
      if (!data.event) return { found: false, event_ticker: et };
      let markets = data.event.markets ?? [];
      let orderbookBatches: number | null = null;
      if (includeOrderbook && markets.length > 0) {
        // Kalshi's nested-markets response leaves prices null for many macro
        // events on the unauth API; the orderbook endpoint does expose depth.
        // One batch call per 100 markets covers the whole partition.
        const target = Number.isFinite(obLimit) ? markets.slice(0, obLimit as number) : markets;
        const patched = await enrichMarketsWithOrderbooks(target);
        orderbookBatches = Math.ceil(target.length / 100);
        markets = Number.isFinite(obLimit) ? [...patched, ...markets.slice(patched.length)] : patched;
      }
      return {
        found: true,
        event: formatEvent(data.event),
        markets: markets.map((m) => formatMarket(m)),
        ...(orderbookBatches !== null
          ? {
              orderbook_source: 'kalshi_batch_orderbooks',
              orderbook_requests: orderbookBatches,
              orderbook_markets_covered: Number.isFinite(obLimit) ? Math.min(markets.length, obLimit as number) : markets.length,
            }
          : {}),
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
      let data = (await kalshiGet(
        `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
      )) as { trades?: Array<Record<string, unknown>>; cursor?: string };
      let source: 'live' | 'archive' = 'live';
      if (!(data.trades && data.trades.length)) {
        // The live trades endpoint answers 200 with `trades: []` for an
        // archived market — a clean, wrong "this market never traded".
        const arch = (await kalshiGet(
          `${ARCHIVE_BASE}/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`,
        )) as { trades?: Array<Record<string, unknown>>; cursor?: string };
        const rows = (arch.trades ?? []).filter(
          (t) => String(t.ticker ?? '').toUpperCase() === ticker.toUpperCase(),
        );
        if (rows.length) {
          data = { trades: rows, cursor: arch.cursor };
          source = 'archive';
        }
      }
      // Kalshi's wire fields are `yes_price_dollars` / `no_price_dollars` /
      // `count_fp`. The bare `yes_price` / `no_price` / `count` this used to
      // read do NOT exist on the trades response, so every trade came back
      // with no price and no size at all — a 200 with the shape of an answer
      // (fleet #2039). Both units are returned now: cents for Kalshi's display
      // convention, dollars at full precision for anything sizing a trade.
      const priceOf = (dollarsField: unknown, centsField: unknown) => {
        const d = toNum(dollarsField);
        const c = toNum(centsField);
        const dollars = d !== null ? d : c !== null ? c / 100 : null;
        return { dollars, cents: dollars !== null ? Math.round(dollars * 100) : null };
      };
      return {
        ticker,
        source,
        ...(source === 'archive'
          ? { source_note: 'Served from Kalshi\'s historical archive (/historical/trades). The live trades endpoint returns an empty 200 for markets this old.' }
          : {}),
        count: data.trades?.length ?? 0,
        cursor: data.cursor ?? null,
        trades: (data.trades ?? []).map((t) => {
          const yes = priceOf(t.yes_price_dollars, t.yes_price);
          const no = priceOf(t.no_price_dollars, t.no_price);
          return {
            trade_id: t.trade_id,
            ticker: t.ticker,
            yes_price_cents: yes.cents,
            yes_price_dollars: yes.dollars,
            no_price_cents: no.cents,
            no_price_dollars: no.dollars,
            count: toNum(t.count_fp ?? t.count),
            taker_side: t.taker_side,
            created_time: t.created_time,
          };
        }),
      };
    }
    case 'kalshi_price_history': {
      const cursorRaw = typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor.trim() : null;
      const resumed = cursorRaw ? decodeCandleCursor(cursorRaw) : null;
      if (cursorRaw && !resumed) {
        return {
          error: 'bad_cursor',
          message: 'The `cursor` value is not one of ours. Pass back the exact `next_cursor` string from a previous kalshi_price_history response, or omit it to start a new window.',
        };
      }

      const ticker = resumed ? resumed.t : reqStr(args, 'ticker', '"KXFEDDECISION-28JAN-H26"');
      const period = resumed ? resumed.p : (PERIOD_MINUTES[String(args.interval ?? '1d').toLowerCase()] ?? 1440);
      const interval = PERIOD_NAME[period] ?? String(args.interval ?? '1d').toLowerCase();
      // Series ticker is the first dash-segment of the market ticker
      // (KXFEDDECISION-28JAN-H26 → KXFEDDECISION). Required in the candlesticks path.
      const series = ticker.split('-')[0];

      // Window. Explicit start_ts/end_ts win; lookback_days is sugar that
      // anchors to whichever end was given, and to "now" when neither was.
      // Before this, `end` was ALWAYS now, so no past window was expressible.
      let start: number;
      let end: number;
      if (resumed) {
        start = resumed.s;
        end = resumed.e;
      } else {
        const nowSec = Math.floor(Date.now() / 1000);
        const wantStart = parseTimeArg(args.start_ts, 'start_ts');
        const wantEnd = parseTimeArg(args.end_ts, 'end_ts');
        const lookbackDays = Math.min(365, Math.max(1, (args.lookback_days as number) ?? 30));
        if (wantStart !== null && wantEnd !== null) {
          start = wantStart;
          end = wantEnd;
        } else if (wantStart !== null) {
          start = wantStart;
          end = wantStart + lookbackDays * 86_400;
        } else if (wantEnd !== null) {
          end = wantEnd;
          start = wantEnd - lookbackDays * 86_400;
        } else {
          end = nowSec;
          start = nowSec - lookbackDays * 86_400;
        }
        if (end <= start) {
          return {
            error: 'bad_window',
            message: `end_ts (${isoOf(end)}) is not after start_ts (${isoOf(start)}). Give a window that runs forwards.`,
            start_ts: start,
            end_ts: end,
          };
        }
      }

      // Chunk to Kalshi's own 5,000-candle ceiling and hand back a cursor for
      // the rest. Oldest-first, so the next page is always DIFFERENT candles.
      const stepSec = period * 60;
      const candlesRequested = Math.ceil((end - start) / stepSec);
      const servedEnd = candlesRequested > MAX_CANDLES_PER_REQUEST
        ? start + MAX_CANDLES_PER_REQUEST * stepSec
        : end;
      const nextCursor = servedEnd < end
        ? encodeCandleCursor({ t: ticker, p: period, s: servedEnd, e: end })
        : null;

      const got = await fetchCandleWindow(ticker, series, period, start, servedEnd);
      if (got.source === null) {
        const err = errorOf(got.data);
        if (err === 'not_found') {
          return {
            found: false,
            ticker,
            series,
            error: 'not_found',
            message: `Kalshi has no candlesticks for "${ticker}" on either the live series path or the historical archive — the ticker is probably wrong.`,
            hint: 'Find a valid ticker with kalshi_markets (pass keyword, and status "settled" for a market that has already resolved).',
          };
        }
        return got.data;
      }

      const raw = (got.data.candlesticks ?? []) as Array<Record<string, unknown>>;
      const candles = raw.map(formatCandle);
      const first = candles.length ? candles[0].timestamp : null;
      const last = candles.length ? candles[candles.length - 1].timestamp : null;

      return {
        ticker,
        series,
        interval,
        period_minutes: period,
        source: got.source,
        source_note: got.source === 'archive'
          ? 'Served from Kalshi\'s historical archive (/historical/markets/{ticker}/candlesticks). Kalshi removes older markets from the live endpoints entirely — the live path 404s for this ticker — so a caller hitting Kalshi directly would have seen "not found" here.'
          : 'Served from Kalshi\'s live series path.',
        // The window actually READ, not the one asked for. When they differ the
        // response is a page, and says so with a cursor — never a quietly
        // shortened series.
        window_requested: { start: isoOf(start), end: isoOf(end), start_ts: start, end_ts: end },
        window_served: { start: isoOf(start), end: isoOf(servedEnd), start_ts: start, end_ts: servedEnd },
        complete: nextCursor === null,
        next_cursor: nextCursor,
        candles_requested: candlesRequested,
        candles_per_request_max: MAX_CANDLES_PER_REQUEST,
        point_count: candles.length,
        first_candle: first,
        last_candle: last,
        coverage: candles.length === 0
          // Say what we KNOW instead of asserting a cause. The old text claimed
          // "(not a tool limit)" unconditionally — including in the one case
          // where it was a limit. Now the window is provably within Kalshi's
          // per-request ceiling before we say anything about why it is empty.
          ? `Kalshi returned 200 with an empty candlestick array for ${isoOf(start)} → ${isoOf(servedEnd)} (${got.source} path). That window is ${Math.min(candlesRequested, MAX_CANDLES_PER_REQUEST)} candle(s) at ${period}m, inside Kalshi's ${MAX_CANDLES_PER_REQUEST}-candle per-request cap, so it was not truncated: Kalshi has no candles here. Usual causes are a market that had not opened yet in this window, or one that never traded in it.`
          : nextCursor
            ? `${candles.length} candle(s) covering ${first} → ${last}. This is a PARTIAL slice: ${candlesRequested} candle slots remained in the requested window and Kalshi serves at most ${MAX_CANDLES_PER_REQUEST} per request. Call kalshi_price_history again with cursor=<next_cursor> (no other arguments) for the next slice, oldest-first, until complete is true.`
            : `${candles.length} candle(s) covering ${first} → ${last}. The whole requested window was served in one request.`,
        candles,
      };
    }
    case 'kalshi_exchange_status': {
      const data = (await kalshiGet('/exchange/status')) as Record<string, unknown>;
      return data;
    }
    case 'kalshi_top_markets':
      return findTopMarkets(args);
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
    case 'kalshi_orderbooks': {
      const tickers = tickerList(args.tickers, 'tickers', 100);
      const depth = Math.min(100, Math.max(1, (args.depth as number) ?? 5));
      const params = new URLSearchParams();
      for (const t of tickers) params.append('tickers', t);
      const data = (await kalshiGet(`/markets/orderbooks?${params}`)) as {
        orderbooks?: Array<{ ticker?: string; orderbook_fp?: { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> } }>;
        error?: string;
        message?: string;
      };
      if (data.error) return { error: data.error, message: data.message, tickers_requested: tickers.length };
      const books = data.orderbooks ?? [];
      const seen = new Set<string>();
      const out = books.map((b) => {
        const tk = String(b.ticker ?? '');
        seen.add(tk.toUpperCase());
        // Kalshi returns bids only, sorted low→high; top of book is the last entry.
        const yes = b.orderbook_fp?.yes_dollars ?? [];
        const no = b.orderbook_fp?.no_dollars ?? [];
        const level = ([price, qty]: [string, string]) => ({
          price_dollars: parseFloat(price),
          price_cents: centsOf(price),
          quantity: parseFloat(qty),
        });
        const yesBids = [...yes].reverse().slice(0, depth).map(level);
        const noBids = [...no].reverse().slice(0, depth).map(level);
        const bestYes = yesBids[0]?.price_dollars ?? null;
        const bestNo = noBids[0]?.price_dollars ?? null;
        return {
          ticker: tk,
          yes_bids: yesBids,
          no_bids: noBids,
          levels_available: { yes: yes.length, no: no.length },
          best_yes_bid_dollars: bestYes,
          best_no_bid_dollars: bestNo,
          // An ask in a binary market IS 1 − the other side's best bid.
          yes_ask_dollars: bestNo != null ? roundDollars(1 - bestNo) : null,
          no_ask_dollars: bestYes != null ? roundDollars(1 - bestYes) : null,
          implied_yes_prob: computeImpliedYesProb(
            bestNo != null ? roundDollars(1 - bestNo) : null,
            bestYes,
            null,
            bestYes != null ? roundDollars(1 - bestYes) : null,
          ),
          quoted: yes.length > 0 || no.length > 0,
        };
      });
      return {
        count: out.length,
        tickers_requested: tickers.length,
        orderbooks: out,
        tickers_without_book: tickers.filter((t) => !seen.has(t.toUpperCase())),
        note: 'Kalshi returns resting BIDS for both sides; an ask is the derived 1 − opposite-side best bid. One request covers up to 100 tickers — Kalshi\'s own cap. `quoted:false` means nobody is resting an order on that market right now, which is a real answer, not an error.',
      };
    }
    case 'kalshi_candlesticks': {
      const tickers = tickerList(args.tickers, 'tickers', 100);
      const period = PERIOD_MINUTES[String(args.interval ?? '1h').toLowerCase()] ?? 60;
      const explicitStart = parseTimeArg(args.start_ts, 'start_ts');
      const explicitEnd = parseTimeArg(args.end_ts, 'end_ts');
      const lookbackDays = Math.min(365, Math.max(1, (args.lookback_days as number) ?? 1));
      const end = explicitEnd ?? (explicitStart != null ? explicitStart + lookbackDays * 86400 : Math.floor(Date.now() / 1000));
      const start = explicitStart ?? end - lookbackDays * 86400;
      const params = new URLSearchParams({
        market_tickers: tickers.join(','),
        start_ts: String(start),
        end_ts: String(end),
        period_interval: String(period),
      });
      const data = (await kalshiGet(`/markets/candlesticks?${params}`)) as {
        markets?: Array<{ market_ticker?: string; ticker?: string; candlesticks?: Array<Record<string, unknown>> }>;
        error?: string;
        message?: string;
      };
      if (data.error) return { error: data.error, message: data.message, tickers_requested: tickers.length };
      const rows = data.markets ?? [];
      // Kalshi names each group `market_ticker` here (not `ticker`, as the
      // single-market endpoint does). Read the upstream label rather than
      // pairing by request order — a reordered response would otherwise
      // attribute one market's whole price history to another, as a clean 200.
      const series = rows.map((m, i) => ({
        ticker: m.market_ticker ?? m.ticker ?? tickers[i] ?? null,
        ticker_source: (m.market_ticker ?? m.ticker) ? 'upstream' : 'request_order',
        candles: (m.candlesticks ?? []).map(formatCandle),
        count: (m.candlesticks ?? []).length,
      }));
      const missing = tickers.filter(
        (t) => !series.some((x) => String(x.ticker ?? '').toUpperCase() === t.toUpperCase()),
      );
      const total = series.reduce((n, s) => n + s.count, 0);
      return {
        count: series.length,
        tickers_requested: tickers.length,
        interval: String(args.interval ?? '1h'),
        period_interval_minutes: period,
        window: { start_ts: start, end_ts: end, start: isoOf(start), end: isoOf(end) },
        candles_total: total,
        truncated_by_upstream: total >= 10000,
        markets: series,
        tickers_without_candles: missing,
        note: 'Kalshi caps this endpoint at 10,000 candles across ALL requested markets combined and has no cursor here — when truncated_by_upstream is true, narrow the window or the ticker list. No archive fallback: an archived market returns no candles here, use kalshi_price_history for those.',
      };
    }
    case 'kalshi_event_live_data': {
      const et = reqStr(args, 'event_ticker', '"KXBTCD-26SEP1617"');
      const maxPoints = Math.min(2000, Math.max(1, (args.max_points as number) ?? 200));
      const qs = args.range ? `?range=${encodeURIComponent(String(args.range))}` : '';
      const data = (await kalshiGet(`/live_data/events/${encodeURIComponent(et)}${qs}`)) as {
        live_data?: { type?: string; details?: Record<string, unknown>; is_historical?: boolean; default_range?: string };
        error?: string;
        message?: string;
      };
      if (isNotFound(data)) {
        return {
          found: false,
          event_ticker: et,
          message: `Kalshi serves no live underlying data for event ${et}. Most events have none — it exists for crypto price events, some economic-series events, and similar. Temperature observations are city-keyed, not event-keyed: use kalshi_weather_index.`,
        };
      }
      if (data.error) return { found: false, event_ticker: et, error: data.error, message: data.message };
      const ld = data.live_data;
      if (!ld) return { found: false, event_ticker: et };
      const details = { ...(ld.details ?? {}) };
      const trimmed: Record<string, { points_total: number; points_returned: number }> = {};
      for (const [k, v] of Object.entries(details)) {
        if (Array.isArray(v) && v.length > maxPoints) {
          trimmed[k] = { points_total: v.length, points_returned: maxPoints };
          details[k] = v.slice(-maxPoints);
        } else if (Array.isArray(v)) {
          trimmed[k] = { points_total: v.length, points_returned: v.length };
        }
      }
      // Kalshi nests candlesticks by bucket name ("15M", "1H", ...) for crypto.
      const candles = details.candlesticks as Record<string, unknown[]> | undefined;
      if (candles && !Array.isArray(candles) && typeof candles === 'object') {
        const bucketed: Record<string, unknown[]> = {};
        for (const [bucket, arr] of Object.entries(candles)) {
          if (!Array.isArray(arr)) continue;
          trimmed[`candlesticks.${bucket}`] = { points_total: arr.length, points_returned: Math.min(arr.length, maxPoints) };
          bucketed[bucket] = arr.slice(-maxPoints);
        }
        details.candlesticks = bucketed;
      }
      const pick = (k: string) => (details[k] === undefined ? null : details[k]);
      return {
        found: true,
        event_ticker: et,
        type: ld.type ?? null,
        is_historical: ld.is_historical ?? (details.is_historical as boolean | undefined) ?? null,
        default_range: ld.default_range ?? (details.default_period as string | undefined) ?? null,
        selectable_periods: pick('selectable_periods'),
        latest_value: pick('latest_value'),
        latest_period: pick('latest_period'),
        unit: pick('unit'),
        measure: pick('measure'),
        frequency: pick('frequency'),
        provider: pick('provider'),
        series_id: pick('series_id'),
        target_label: pick('target_label'),
        target_period: pick('target_period'),
        last_refreshed: pick('last_refreshed'),
        coin: pick('coin'),
        series_trimmed: trimmed,
        details,
        note: 'The `type` field names the schema of `details` — Kalshi defines it, we pass it through rather than flattening every variant into a lowest common denominator. Arrays are trimmed to the NEWEST max_points; series_trimmed reports the untrimmed length of each.',
      };
    }
    case 'kalshi_game_stats': {
      const id = reqStr(args, 'milestone_id', '"ce57e3ef-6b6a-4680-a849-5965021aaac2"');
      const limit = Math.min(500, Math.max(1, (args.limit as number) ?? 25));
      const [stateRes, statsRes] = await Promise.all([
        kalshiGet(`/live_data/milestone/${encodeURIComponent(id)}`),
        kalshiGet(`/live_data/milestone/${encodeURIComponent(id)}/game_stats`),
      ]);
      if (isNotFound(stateRes) && isNotFound(statsRes)) {
        return { found: false, milestone_id: id, message: `Kalshi has no milestone ${id}. Find one with kalshi_milestones.` };
      }
      const state = (stateRes as { live_data?: { type?: string; details?: Record<string, unknown> } }).live_data;
      const pbp = (statsRes as { pbp?: { periods?: Array<Record<string, unknown>> } }).pbp ?? {};
      const periods = Array.isArray(pbp.periods) ? pbp.periods : [];
      const plays: Array<Record<string, unknown>> = [];
      for (const p of periods) {
        const evs = (p as { events?: Array<Record<string, unknown>> }).events ?? [];
        for (const e of evs) {
          plays.push({
            description: e.description ?? null,
            type: e.type ?? null,
            home_points: e.home_points ?? null,
            away_points: e.away_points ?? null,
            clock: e.clock ?? null,
            wall_clock: e.wall_clock ?? null,
            sequence: e.sequence ?? null,
          });
        }
      }
      plays.sort((a, b) => Number(b.sequence ?? 0) - Number(a.sequence ?? 0));
      return {
        found: true,
        milestone_id: id,
        type: state?.type ?? null,
        scoreboard: state?.details ?? null,
        plays_available: plays.length > 0,
        plays_total: plays.length,
        plays: plays.slice(0, limit),
        periods: periods.length,
        note: plays.length > 0
          ? 'Plays are newest-first. `scoreboard` is Kalshi\'s live state object for this milestone type (score, period, status, last play).'
          : 'Kalshi answered 200 with no play-by-play for this milestone. Play-by-play covers Pro/College Football, Pro/College Basketball, WNBA, Soccer, Pro Hockey and Pro Baseball via Sportradar; anything else returns an empty set, which is what happened here — it is not an error and not a game with zero plays.',
      };
    }
    case 'kalshi_milestones': {
      const params = new URLSearchParams();
      // Kalshi REQUIRES limit on this endpoint — omitting it is a 400.
      params.set('limit', String(Math.min(200, Math.max(1, (args.limit as number) ?? 50))));
      if (args.category) params.set('category', String(args.category));
      if (args.type) params.set('type', String(args.type));
      if (args.competition) params.set('competition', String(args.competition));
      if (args.related_event_ticker) params.set('related_event_ticker', String(args.related_event_ticker));
      if (args.minimum_start_date) params.set('minimum_start_date', String(args.minimum_start_date));
      if (args.cursor) params.set('cursor', String(args.cursor));
      const data = (await kalshiGet(`/milestones?${params}`)) as {
        milestones?: Array<Record<string, unknown>>;
        cursor?: string;
        error?: string;
        message?: string;
      };
      if (data.error) return { error: data.error, message: data.message };
      const rows = data.milestones ?? [];
      return {
        count: rows.length,
        next_cursor: data.cursor || null,
        milestones: rows.map((m) => ({
          id: m.id ?? null,
          title: m.title ?? null,
          type: m.type ?? null,
          category: m.category ?? null,
          competition: m.competition ?? null,
          start_date: m.start_date ?? null,
          end_date: m.end_date ?? null,
          notification_message: m.notification_message ?? null,
          primary_event_tickers: m.primary_event_tickers ?? [],
          related_event_tickers: m.related_event_tickers ?? [],
          source_ids: m.source_ids ?? {},
          last_updated_ts: m.last_updated_ts ?? null,
        })),
        note: 'related_event_tickers is Kalshi\'s own link from an occurrence to its tradeable events — use it instead of matching titles. Kalshi\'s unfiltered page skews historical; pass minimum_start_date for current occurrences. A milestone id is the key for kalshi_game_stats.',
      };
    }
    case 'kalshi_structured_targets': {
      const params = new URLSearchParams();
      params.set('page_size', String(Math.min(2000, Math.max(1, (args.page_size as number) ?? 100))));
      if (args.type) params.set('type', String(args.type));
      if (args.competition) params.set('competition', String(args.competition));
      if (args.ids !== undefined) for (const id of tickerList(args.ids, 'ids', 100)) params.append('ids', id);
      if (args.cursor) params.set('cursor', String(args.cursor));
      const data = (await kalshiGet(`/structured_targets?${params}`)) as {
        structured_targets?: Array<Record<string, unknown>>;
        cursor?: string;
        error?: string;
        message?: string;
      };
      if (data.error) return { error: data.error, message: data.message };
      const rows = data.structured_targets ?? [];
      const filtered = Boolean(args.type || args.competition || args.ids);
      return {
        count: rows.length,
        next_cursor: data.cursor || null,
        ...(rows.length === 0 && filtered
          ? {
              filter_note: `Kalshi answered 200 with an empty list. It does not reject an unknown filter value, so this is either a real "nothing matches" or a type it has never heard of. Kalshi's types are granular by sport — the ones seen live on 2026-09-16 are: ${STRUCTURED_TARGET_TYPES.join(', ')}. There is no bare "player", "team" or "athlete" type.`,
              known_types: STRUCTURED_TARGET_TYPES,
            }
          : {}),
        structured_targets: rows.map((t) => ({
          id: t.id ?? null,
          name: t.name ?? null,
          type: t.type ?? null,
          details: t.details ?? {},
          source_ids: t.source_ids ?? {},
          last_updated_ts: t.last_updated_ts ?? null,
        })),
        note: 'A reference index of the entities Kalshi models — no prices here. `details` is type-specific: a player carries league/position/team_id, an actor carries films.',
      };
    }
    case 'kalshi_weather_index': {
      const city = reqStr(args, 'city', '"nyc"').toLowerCase();
      const maxPoints = Math.min(5000, Math.max(1, (args.max_points as number) ?? 500));
      const params = new URLSearchParams();
      const from = args.from as number | undefined;
      const to = args.to as number | undefined;
      if (typeof from === 'number') {
        params.set('from', String(Math.floor(from)));
        if (typeof to === 'number') params.set('to', String(Math.floor(to)));
      } else {
        params.set('last_sec', String(Math.max(60, Math.floor((args.last_sec as number) ?? 3600))));
      }
      if (args.detailed === true) params.set('detailed', 'true');
      const data = (await kalshiGet(`/live_data/weather/${encodeURIComponent(city)}?${params}`)) as {
        city?: string;
        config_version?: string;
        units?: string;
        timeseries?: Array<Record<string, unknown>>;
        error?: string;
        message?: string;
        status?: number;
      };
      if (data.error) {
        return {
          error: 'unknown_city',
          city,
          supported_cities: WEATHER_INDEX_CITIES,
          message: `Kalshi has no weather index for "${city}". Supported city ids: ${WEATHER_INDEX_CITIES.join(', ')}.`,
          upstream: data.message ?? null,
        };
      }
      const pts = data.timeseries ?? [];
      const kept = pts.slice(-maxPoints);
      const latest = kept.length ? kept[kept.length - 1] : null;
      return {
        city: data.city ?? city,
        config_version: data.config_version ?? null,
        units: data.units ?? null,
        points: kept.length,
        points_total: pts.length,
        latest: latest
          ? { t: latest.t ?? null, iso: latest.t ? new Date(Number(latest.t)).toISOString() : null, value: latest.v ?? null, contributors: latest.contributors ?? null, status: latest.status ?? null }
          : null,
        timeseries: kept.map((p) => ({
          t: p.t ?? null,
          iso: p.t ? new Date(Number(p.t)).toISOString() : null,
          value: p.v ?? null,
          contributors: p.contributors ?? null,
          status: p.status ?? null,
          ...(args.detailed === true && p.readings !== undefined ? { readings: p.readings } : {}),
        })),
        note: 'Kalshi\'s own multi-station index, Fahrenheit to 0.01, one point per minute — this is what a temperature contract settles on, not a forecast and not one station. `from`/`to` are unix MILLISECONDS. A window shorter than a couple of minutes can legitimately return zero points. For the station weights behind each number, call kalshi_weather_index_calibrations.',
      };
    }
    case 'kalshi_weather_index_calibrations': {
      const city = reqStr(args, 'city', '"nyc"').toLowerCase();
      const data = (await kalshiGet(`/live_data/weather/${encodeURIComponent(city)}/calibrations`)) as {
        calibrations?: Array<Record<string, unknown>>;
        error?: string;
        message?: string;
      };
      if (data.error) {
        return {
          error: 'unknown_city',
          city,
          supported_cities: WEATHER_INDEX_CITIES,
          message: `Kalshi has no weather index for "${city}". Supported city ids: ${WEATHER_INDEX_CITIES.join(', ')}.`,
          upstream: data.message ?? null,
        };
      }
      const rows = data.calibrations ?? [];
      return {
        city,
        count: rows.length,
        latest_config_version: rows.length ? (rows[rows.length - 1].config_version ?? null) : null,
        calibrations: rows.map((c) => ({
          config_version: c.config_version ?? null,
          change_reason: c.change_reason ?? null,
          effective_at_ms: c.effective_at_ms ?? null,
          effective_at: c.effective_at_ms ? new Date(Number(c.effective_at_ms)).toISOString() : null,
          published_at_ms: c.published_at_ms ?? null,
          calibration_window_start_ms: c.calibration_window_start_ms ?? null,
          calibration_window_end_ms: c.calibration_window_end_ms ?? null,
          city_reference_c: c.city_reference_c ?? null,
          stations: c.stations ?? [],
        })),
        note: 'Ascending by effective time: the launch configuration first, then every weekly offset calibration and methodology update. Offsets are in CELSIUS while the index itself is published in Fahrenheit.',
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
  series_ticker?: string;
  title?: string;
  subtitle?: string;
  /** Settled outcome, "yes" | "no". Absent while the market is live. */
  result?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  status?: string;
  // Live Kalshi API (verified 2026-09-03): prices are `*_dollars` strings and
  // volume/open-interest are `*_fp` (fractional-point) strings, NOT the plain
  // cents-integer fields (yes_ask, volume, open_interest...) this pack was
  // reading — those never exist on the wire, so every price/volume/open-interest
  // field silently came back null (200 OK, no error) from every kalshi_* tool.
  // Fleet #1220. `yes_ask` etc (no suffix) are kept below ONLY as the shape
  // enrichMarketsWithOrderbooks patches in when the dollar fields are absent.
  yes_ask_dollars?: string;
  yes_bid_dollars?: string;
  no_ask_dollars?: string;
  no_bid_dollars?: string;
  last_price_dollars?: string;
  // Top-of-book SIZE (contracts resting at the best price), string from the
  // orderbook ladder's [price, size] pairs. Only ever set for the two REAL
  // (not derived) sides — see enrichMarketsWithOrderbooks. No dollars/cents
  // conversion needed; size is already a plain quantity.
  yes_bid_size?: string;
  no_bid_size?: string;
  volume_fp?: string | number;
  volume_24h_fp?: string | number;
  open_interest_fp?: string | number;
  liquidity_dollars?: string;
  // Legacy shape (integer cents) — this is what Kalshi's search endpoint
  // (api.elections.kalshi.com/v1/search/series) actually returns on the wire
  // for `markets[].yes_bid/yes_ask/last_price`, so it is genuinely correct
  // there (searchApiResult reads it directly) and dollarsOf() below prefers it
  // when present. It is NOT used by enrichMarketsWithOrderbooks any more —
  // that path now writes the *_dollars fields above so sub-cent precision
  // from the fixed-point orderbook survives (fleet #2038).
  yes_ask?: number;
  yes_bid?: number;
  no_ask?: number;
  no_bid?: number;
  last_price?: number;
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

// ── Category resolution ──────────────────────────────────────────────
//
// Kalshi serves category on the SERIES (/series/{ticker} → {ticker, title,
// category, frequency}, ~800 bytes) and on its search rows — never on
// /markets. The full /series listing is 16.9 MB for 14,091 series, so we
// resolve per distinct series instead and cache: a series' category never
// changes, and a 100-market page spans only a handful of series (measured
// 2026-09-15: two). The cache lives as long as the isolate; it is an
// immutable lookup, so concurrent calls cannot see a conflicting value.
const SERIES_CATEGORY = new Map<string, string | null>();
// Bound the fan-out. A pathological page spanning hundreds of series
// degrades into a STATED omission, not hundreds of subrequests.
const SERIES_LOOKUP_BUDGET = 40;

function seriesTickerOf(eventTicker?: string | null): string | null {
  if (!eventTicker) return null;
  return String(eventTicker).split('-')[0] || null;
}

/** Warm SERIES_CATEGORY for these series. Returns the ones the budget skipped. */
async function resolveSeriesCategories(tickers: Array<string | null | undefined>): Promise<string[]> {
  const wanted = [...new Set(tickers.filter((t): t is string => !!t))]
    .filter((t) => !SERIES_CATEGORY.has(t));
  const fetchable = wanted.slice(0, SERIES_LOOKUP_BUDGET);
  await Promise.all(
    fetchable.map(async (t) => {
      try {
        const d = (await kalshiGet(`/series/${encodeURIComponent(t)}`)) as {
          series?: { category?: string };
          category?: string;
        };
        SERIES_CATEGORY.set(t, d.series?.category || d.category || null);
      } catch {
        SERIES_CATEGORY.set(t, null);
      }
    }),
  );
  return wanted.slice(SERIES_LOOKUP_BUDGET);
}

function categoryFor(eventTicker?: string | null): string | null {
  const s = seriesTickerOf(eventTicker);
  return s ? SERIES_CATEGORY.get(s) ?? null : null;
}

/**
 * Full market rows for a set of tickers, in one call per 50 tickers.
 * Kalshi's /markets accepts a comma-separated `tickers=` filter (verified
 * 2026-09-15) — this is how the keyword path gets the fields Kalshi's own
 * search endpoint omits: title, status, no_ask, volume_24h, open_interest,
 * liquidity and result.
 */
async function marketsByTicker(tickers: Array<string | undefined>): Promise<Map<string, KalshiMarket>> {
  const out = new Map<string, KalshiMarket>();
  const unique = [...new Set(tickers.filter((t): t is string => !!t))];
  const CHUNK = 50;
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const qs = chunk.map((t) => encodeURIComponent(t)).join(',');
        const d = (await kalshiGet(`/markets?tickers=${qs}&limit=${chunk.length}`)) as {
          markets?: KalshiMarket[];
        };
        for (const m of d.markets ?? []) if (m.ticker) out.set(m.ticker, m);
        // Anything the live listing dropped is either a bad ticker or an
        // ARCHIVED market — Kalshi returns 200 with `markets: []` for the
        // latter, so without this the settled-keyword path enriched nothing
        // and reported the whole answer as fields_omitted.
        const missing = chunk.filter((t) => !out.has(t));
        if (missing.length) {
          const aq = missing.map((t) => encodeURIComponent(t)).join(',');
          const a = (await kalshiGet(`${ARCHIVE_BASE}/markets?tickers=${aq}&limit=${missing.length}`)) as {
            markets?: KalshiMarket[];
          };
          for (const m of a.markets ?? []) {
            if (m.ticker && missing.includes(m.ticker)) out.set(m.ticker, m);
          }
        }
      } catch {
        // Leave those tickers unenriched; the caller lists them in fields_omitted.
      }
    }),
  );
  return out;
}

// The field set every kalshi_markets path returns, in both directions: the
// keyword path fills these from /markets?tickers=, the list path fills
// category from /series/{ticker}. Named here so a response can say exactly
// which of them it could not populate instead of shipping a silent null.
const MARKET_FIELDS = [
  'ticker', 'event_ticker', 'series_ticker', 'title', 'subtitle', 'status',
  'yes_ask_cents', 'yes_bid_cents', 'no_ask_cents', 'last_price_cents',
  'implied_yes_prob', 'implied_yes_prob_source', 'volume', 'volume_24h',
  'open_interest', 'liquidity', 'close_time', 'category', 'result',
];

// ── Formatters ───────────────────────────────────────────────────────

// Trim a market down to the fields agents actually use; include rules text
// only on the full single-market lookup so list responses stay small.
function toNum(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

// Full-precision price in dollars (0-1), NO rounding. This — not a
// cents-rounded number — is the source of truth every *_cents output field
// and implied_yes_prob is DERIVED from (see formatMarket), so a genuine
// sub-cent quote (0.335) survives instead of being silently rounded to 34
// cents / 0.34 probability the way it was before fleet #2038.
//
// Precedence: the legacy integer-cents field (real cents from Kalshi's
// search endpoint — see the KalshiMarket interface comment) wins when
// present, converted to dollars exactly (cents/100 has no more precision to
// lose); otherwise parse the wire's `*_dollars` fixed-point string.
function dollarsOf(dollarsField: unknown, legacyCentsField: unknown): number | null {
  if (typeof legacyCentsField === 'number') return legacyCentsField / 100;
  return toNum(dollarsField);
}

function formatMarket(m: KalshiMarket, full = false): Record<string, unknown> {
  // Prefer the mid of bid/ask (real two-sided market). When only one side
  // is quoted, fall back to that side. When the orderbook is empty, use
  // last_price (the most recent trade). When even that's missing, infer
  // yes_prob from no_ask (1 - no/100). Empty orderbook is common on
  // forward-dated event markets (e.g., KXCPI-26NOV has 7 buckets with
  // no asks yet), and dropping them silently breaks downstream tools
  // like polymarket_kalshi_spread that filter on yes_prob != null.
  // Full-precision dollar values (0-1) are the source of truth; *_cents
  // fields below are ROUNDED FOR DISPLAY from these, not computed
  // independently, so the two can never disagree (fleet #2038).
  const yesAskDollars = dollarsOf(m.yes_ask_dollars, m.yes_ask);
  const yesBidDollars = dollarsOf(m.yes_bid_dollars, m.yes_bid);
  const noAskDollars = dollarsOf(m.no_ask_dollars, m.no_ask);
  const lastPriceDollars = dollarsOf(m.last_price_dollars, m.last_price);
  const yesAskCents = yesAskDollars !== null ? Math.round(yesAskDollars * 100) : null;
  const yesBidCents = yesBidDollars !== null ? Math.round(yesBidDollars * 100) : null;
  const noAskCents = noAskDollars !== null ? Math.round(noAskDollars * 100) : null;
  const lastPriceCents = lastPriceDollars !== null ? Math.round(lastPriceDollars * 100) : null;
  const { value: impliedYesProb, source: impliedYesProbSource } =
    computeImpliedYesProb(yesAskDollars, yesBidDollars, lastPriceDollars, noAskDollars);
  const yesBidSize = toNum(m.yes_bid_size);
  const noBidSize = toNum(m.no_bid_size);
  const base: Record<string, unknown> = {
    ticker: m.ticker ?? null,
    event_ticker: m.event_ticker ?? null,
    title: m.title ?? null,
    subtitle: m.subtitle ?? m.yes_sub_title ?? null,
    status: m.status ?? null,
    // Rounded-to-the-cent display values (Kalshi's UI convention). For the
    // true, unrounded quote use the *_dollars siblings below — a genuine
    // sub-cent price (e.g. 0.335) rounds to 34 here but reads exactly as
    // 0.335 there. Added additively 2026-09-15 (fleet #2038); *_cents keeps
    // meaning cents, unchanged for every existing caller.
    yes_ask_cents: yesAskCents,
    yes_bid_cents: yesBidCents,
    no_ask_cents: noAskCents,
    last_price_cents: lastPriceCents,
    yes_ask_dollars: yesAskDollars,
    yes_bid_dollars: yesBidDollars,
    no_ask_dollars: noAskDollars,
    last_price_dollars: lastPriceDollars,
    implied_yes_prob: impliedYesProb,
    implied_yes_prob_source: impliedYesProbSource,
    volume: toNum(m.volume_fp),
    volume_24h: toNum(m.volume_24h_fp),
    open_interest: toNum(m.open_interest_fp),
    liquidity: toNum(m.liquidity_dollars),
    close_time: m.close_time ?? m.expiration_time ?? null,
    // A market's series is the prefix of its event_ticker before the first
    // '-', and it is the handle every other Kalshi tool takes — surface it on
    // every path rather than making callers parse the ticker.
    series_ticker: m.series_ticker ?? seriesTickerOf(m.event_ticker),
    // Kalshi's /markets response carries NO category field (verified
    // 2026-09-15: its 41 keys include volume_fp, open_interest_fp and
    // liquidity_dollars, and no category), while the search API returns one
    // per row. That asymmetry is what made category and liquidity mutually
    // exclusive on this tool. Category actually lives on the SERIES, so both
    // paths now resolve it there; see resolveSeriesCategories.
    category: m.category ?? categoryFor(m.event_ticker),
    // Settled outcome: "yes" | "no" on a finalized market, null while live.
    // Kalshi has always returned this and we dropped it on the floor, which made
    // the pack unable to answer "what actually happened" for any settled market —
    // so no backtest, no calibration, no scoring of anything against reality.
    // Verified upstream 2026-09-13: the KXHIGHNY-26SEP11 ladder returns
    // result:"yes" on B79.5 and "no" on the other five. Additive field; nothing
    // reads position here. (Surfaced for kalshi_weather_edge, #1912.)
    // Normalise Kalshi's "" (not settled yet) to null so an unsettled market
    // reads the same on every path instead of "" here and null there.
    result: m.result || null,
  };
  // Top-of-book size, only ever populated by enrichMarketsWithOrderbooks and
  // only for the two REAL resting sides (yes_bid, no_bid) — yes_ask/no_ask
  // above are DERIVED prices (1 - opposite best bid), not a separate resting
  // order, so there is no independent size to report for them; that omission
  // is intentional, not a gap (fleet #2038 acceptance: state it, don't guess).
  if (yesBidSize !== null) base.yes_bid_size = yesBidSize;
  if (noBidSize !== null) base.no_bid_size = noBidSize;
  if (full) {
    base.rules_primary = m.rules_primary ?? null;
    base.rules_secondary = m.rules_secondary ?? null;
  }
  return base;
}

function computeImpliedYesProb(
  yesAskDollars: number | null,
  yesBidDollars: number | null,
  lastPriceDollars: number | null,
  noAskDollars: number | null,
): { value: number | null; source: string | null } {
  // Mid-price when both sides quoted. Values are already full-precision
  // dollars (0-1) — no /100 here, unlike the pre-fleet-#2038 version which
  // derived this from already-rounded cents and threw sub-cent precision away.
  if (yesAskDollars !== null && yesBidDollars !== null) {
    return { value: +((yesAskDollars + yesBidDollars) / 2).toFixed(4), source: 'mid' };
  }
  if (yesAskDollars !== null) return { value: +yesAskDollars.toFixed(4), source: 'yes_ask' };
  if (yesBidDollars !== null) return { value: +yesBidDollars.toFixed(4), source: 'yes_bid' };
  if (lastPriceDollars !== null) return { value: +lastPriceDollars.toFixed(4), source: 'last_price' };
  // Infer from no_ask: if NO is offered at X, YES is implied at (1 - X)
  if (noAskDollars !== null) return { value: +(1 - noAskDollars).toFixed(4), source: 'inferred_from_no_ask' };
  return { value: null, source: null };
}

// Round to 6 decimal places — enough headroom for any tick size Kalshi uses
// (observed down to tenths of a cent) while killing the binary-float noise
// that `1 - 0.335` etc would otherwise leave in the JSON (0.6650000000000001).
function roundDollars(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// Patch a market with top-of-book derived from the /orderbook endpoint.
// Why this exists: Kalshi's /events/...?with_nested_markets=true endpoint
// returns null prices for most macro events on the unauth API right now,
// even though the /orderbook endpoint exposes a full depth ladder. The
// orderbook returns yes_dollars / no_dollars as [price_string, size_string]
// arrays sorted from low → high price. Best YES bid = highest yes_dollars
// price (most aggressive buyer of YES). Best YES ask = 1 − best NO bid
// (someone bidding 0.99 for NO implicitly offers YES at 0.01).
//
// FLEET #2038: this used to compute Math.round(bestYesBid * 100) and stash
// the result as an INTEGER-CENTS number in the legacy yes_bid/yes_ask/no_bid/
// no_ask fields — silently truncating a genuine 0.335 quote to 34 (and
// implied_yes_prob to 0.34) with nothing in the response recording that a
// quantization happened. It also read only ladder[i][0] (price), discarding
// ladder[i][1] (size) outright. Fixed: write the *_dollars STRING fields
// (same shape the nested-markets wire response already uses) so formatMarket
// carries the full fixed-point precision through untouched, and preserve the
// top-of-book SIZE for the two REAL resting sides. yes_ask/no_ask are DERIVED
// prices (1 - the opposite side's best bid), not a separate resting order, so
// there is no size to report for them — see the comment on yes_bid_size in
// the KalshiMarket interface.
/**
 * Top-of-book for a whole slate of markets using Kalshi's BATCH orderbook
 * endpoint — one request per 100 tickers instead of one per market. Replaces
 * the old Promise.all fan-out, whose 30-market cap silently dropped every
 * child market past the 30th on a larger event (fleet #2040). Markets that
 * already carry a quote are left alone and not re-requested.
 */
async function enrichMarketsWithOrderbooks(markets: KalshiMarket[]): Promise<KalshiMarket[]> {
  const need = markets.filter((m) => m.ticker && !m.yes_ask_dollars && !m.yes_bid_dollars);
  if (need.length === 0) return markets;
  const books = new Map<string, { yes: Array<[string, string]>; no: Array<[string, string]> }>();
  for (let i = 0; i < need.length; i += 100) {
    const chunk = need.slice(i, i + 100);
    const params = new URLSearchParams();
    for (const m of chunk) params.append('tickers', String(m.ticker));
    const res = (await kalshiGet(`/markets/orderbooks?${params}`)) as {
      orderbooks?: Array<{ ticker?: string; orderbook_fp?: { yes_dollars?: Array<[string, string]>; no_dollars?: Array<[string, string]> } }>;
    };
    for (const b of res.orderbooks ?? []) {
      if (!b.ticker) continue;
      books.set(String(b.ticker).toUpperCase(), {
        yes: b.orderbook_fp?.yes_dollars ?? [],
        no: b.orderbook_fp?.no_dollars ?? [],
      });
    }
  }
  return markets.map((m) => {
    if (!m.ticker) return m;
    const book = books.get(m.ticker.toUpperCase());
    if (!book) return m;
    // yes_dollars/no_dollars sorted low→high; top of book is the last entry.
    const bestYes = book.yes.length > 0 ? book.yes[book.yes.length - 1] : null;
    const bestNo = book.no.length > 0 ? book.no[book.no.length - 1] : null;
    const bestYesBid = bestYes ? parseFloat(bestYes[0]) : null;
    const bestNoBid = bestNo ? parseFloat(bestNo[0]) : null;
    const yesAskDollars = bestNoBid != null ? roundDollars(1 - bestNoBid) : null;
    const noAskDollars = bestYesBid != null ? roundDollars(1 - bestYesBid) : null;
    return {
      ...m,
      yes_bid_dollars: m.yes_bid_dollars ?? (bestYesBid != null ? String(bestYesBid) : undefined),
      yes_ask_dollars: m.yes_ask_dollars ?? (yesAskDollars != null ? String(yesAskDollars) : undefined),
      no_bid_dollars: m.no_bid_dollars ?? (bestNoBid != null ? String(bestNoBid) : undefined),
      no_ask_dollars: m.no_ask_dollars ?? (noAskDollars != null ? String(noAskDollars) : undefined),
      yes_bid_size: m.yes_bid_size ?? (bestYes ? bestYes[1] : undefined),
      no_bid_size: m.no_bid_size ?? (bestNo ? bestNo[1] : undefined),
    } as KalshiMarket;
  });
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

// ── Historical / archive reach ───────────────────────────────────────
//
// Kalshi partitions its corpus. A market that has settled recently still
// answers on the live endpoints, but once it is old enough Kalshi MOVES it:
// verified 2026-09-15 against the public API, `/markets/PRES-2024-DJT` is a
// 404, `/markets/trades?ticker=PRES-2024-DJT` is a 200 with `trades: []`,
// and `/markets?tickers=PRES-2024-DJT` is a 200 with `markets: []` — while
// `/historical/markets?tickers=PRES-2024-DJT`, `/historical/trades?ticker=…`
// and `/historical/markets/PRES-2024-DJT/candlesticks` all return the real
// data, unauthenticated. The empty-200 is the dangerous half: a caller asking
// "how did the 2024 presidential market trade" got a clean, wrong "no trades".
//
// So every historical read here tries live first and falls back to the archive,
// and SAYS which one answered in `source`. The cutoff moves, so nothing in this
// pack hardcodes it — the fallback is what makes it invisible to the caller.
const ARCHIVE_BASE = '/historical';

/** True when kalshiGet's normalized envelope says "upstream had no such thing". */
function isNotFound(v: unknown): boolean {
  return !!v && typeof v === 'object' && (v as { error?: string }).error === 'not_found';
}

function errorOf(v: unknown): string | null {
  const e = (v as { error?: unknown } | null | undefined)?.error;
  return typeof e === 'string' ? e : null;
}

// Kalshi's own per-request ceiling on candlesticks, verified 2026-09-15 on both
// the live and the archive path: asking for more returns HTTP 400 with
// `details: "requested time range with candlesticks: 525600.000000, max
// candlesticks: 5000"`. It is a LOUD refusal, not a silent trim — which is why
// the old lookback_days=365 + interval=1m combination could never return a
// short series, it simply errored. We now chunk to this bound and hand back a
// cursor instead.
const MAX_CANDLES_PER_REQUEST = 5000;

const PERIOD_MINUTES: Record<string, number> = {
  '1m': 1, '1min': 1, '1h': 60, '1hr': 60, '1d': 1440, '1day': 1440,
};
const PERIOD_NAME: Record<number, string> = { 1: '1m', 60: '1h', 1440: '1d' };

interface CandleCursor {
  /** market ticker */ t: string;
  /** period_interval in minutes */ p: number;
  /** next window start (unix seconds) */ s: number;
  /** final window end the caller originally asked for (unix seconds) */ e: number;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

function encodeCandleCursor(c: CandleCursor): string {
  return b64urlEncode(JSON.stringify(c));
}

function decodeCandleCursor(raw: string): CandleCursor | null {
  try {
    const c = JSON.parse(b64urlDecode(raw)) as Partial<CandleCursor>;
    if (typeof c.t !== 'string' || !c.t) return null;
    if (typeof c.p !== 'number' || !Number.isFinite(c.p)) return null;
    if (typeof c.s !== 'number' || !Number.isFinite(c.s)) return null;
    if (typeof c.e !== 'number' || !Number.isFinite(c.e)) return null;
    return { t: c.t, p: c.p, s: Math.floor(c.s), e: Math.floor(c.e) };
  } catch {
    return null;
  }
}

/**
 * Accept a time as ISO date ("2026-03-01"), ISO datetime, or unix seconds.
 * Throws with the offending value named, rather than silently becoming NaN and
 * then becoming "now" — a wrong window that looks like a right one is exactly
 * the failure this tool is being fixed for.
 */
function parseTimeArg(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d{9,11}$/.test(s)) return parseInt(s, 10);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  if (!Number.isFinite(ms)) {
    throw new Error(
      `Argument "${field}" is not a time I can read: ${JSON.stringify(v)}. Pass an ISO date ("2026-03-01"), an ISO datetime ("2026-03-01T00:00:00Z"), or unix seconds.`,
    );
  }
  return Math.floor(ms / 1000);
}

const isoOf = (unix: number): string => new Date(unix * 1000).toISOString();

/**
 * Candles for one window, live-then-archive. Returns which endpoint answered so
 * the response can say so; a 404 on BOTH is a genuine unknown ticker, and any
 * other upstream error is surfaced verbatim rather than retried into the
 * archive (a 400 for a bad window would otherwise come back as "not found").
 */
async function fetchCandleWindow(
  ticker: string,
  series: string,
  period: number,
  start: number,
  end: number,
): Promise<{ source: 'live' | 'archive'; data: Record<string, unknown> } | { source: null; data: Record<string, unknown> }> {
  const qs = `start_ts=${start}&end_ts=${end}&period_interval=${period}`;
  const live = (await kalshiGet(
    `/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(ticker)}/candlesticks?${qs}`,
  )) as Record<string, unknown>;
  if (!errorOf(live)) return { source: 'live', data: live };
  if (!isNotFound(live)) return { source: null, data: live };

  const archive = (await kalshiGet(
    `${ARCHIVE_BASE}/markets/${encodeURIComponent(ticker)}/candlesticks?${qs}`,
  )) as Record<string, unknown>;
  if (!errorOf(archive)) return { source: 'archive', data: archive };
  return { source: null, data: archive };
}

/**
 * Normalize a candle from EITHER shape. The live endpoint emits
 * `price.close_dollars` / `volume_fp` / `open_interest_fp`; the archive emits
 * `price.close` / `volume` / `open_interest` with the same dollar semantics
 * (verified 2026-09-15 on PRES-2024-DJT). Reading only one shape is how a
 * whole series comes back as nulls with a 200.
 */
function formatCandle(c: Record<string, unknown>) {
  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const pick = (obj: unknown, ...fields: string[]): number | null => {
    const o = obj as Record<string, unknown> | undefined;
    if (!o) return null;
    for (const f of fields) {
      const n = num(o[f]);
      if (n !== null) return n;
    }
    return null;
  };
  const price = c.price as Record<string, unknown> | undefined;
  return {
    timestamp: c.end_period_ts ? isoOf(Number(c.end_period_ts)) : null,
    unix: c.end_period_ts ?? null,
    yes_open: pick(price, 'open_dollars', 'open'),
    yes_high: pick(price, 'high_dollars', 'high'),
    yes_low: pick(price, 'low_dollars', 'low'),
    yes_close: pick(price, 'close_dollars', 'close'),
    yes_mean: pick(price, 'mean_dollars', 'mean'),
    yes_bid_close: pick(c.yes_bid, 'close_dollars', 'close'),
    yes_ask_close: pick(c.yes_ask, 'close_dollars', 'close'),
    volume: num(c.volume_fp ?? c.volume),
    open_interest: num(c.open_interest_fp ?? c.open_interest),
  };
}

/** Cents from a Kalshi `*_dollars` string, full precision preserved alongside. */
function centsOf(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// ── Helpers ──────────────────────────────────────────────────────────

// Set at the top of callTool from gateway-injected _proxyUrl/_proxyToken.
// Module-level is safe: the gateway injects the SAME proxy creds (its env) for
// every kalshi call, or none — so concurrent calls in one isolate never see a
// conflicting value. Kalshi filters Cloudflare egress IPs on its listing
// endpoints (returns empty to CF Workers); when a non-CF relay is configured we
// route every upstream fetch through it (the relay returns Kalshi's response
// verbatim, so status handling below is unchanged).
let PROXY: { url: string; token: string } | null = null;

// Kalshi's structured-target types, counted off a live 500-row page
// (2026-09-16). Granular by sport: there is no bare "player" or "team", and an
// unknown value is NOT rejected — it returns 200 with an empty list, which is
// why the handler names these when a filtered query comes back empty.
const STRUCTURED_TARGET_TYPES = [
  'actor', 'album', 'baseball_player', 'baseball_team', 'basketball_player',
  'basketball_team', 'company', 'couple', 'cricket_team', 'darts_competitor',
  'esports_competitor', 'film', 'football_player', 'football_team',
  'golf_competitor', 'hockey_player', 'politician', 'racing_competitor',
  'soccer_player', 'soccer_team', 'song', 'table_tennis_competitor',
  'tennis_competitor', 'tv_show', 'ufc_competitor', 'volleyball_team',
];

// Kalshi's thirteen weather-index city ids, read off Kalshi's own rejection
// message for an unknown city (verified live 2026-09-16). These are index ids,
// not place names — "austin" is not one of them and "la-coastal" is.
const WEATHER_INDEX_CITIES = [
  'miami', 'dfw', 'houston', 'phl-delaware-valley', 'puget-sound', 'sf-bay',
  'greater-boston', 'southeast-michigan', 'kansas-city', 'minneapolis-st-paul',
  'nyc', 'chicago', 'la-coastal',
] as const;

/**
 * Normalize a list argument (array, or a comma-separated string a caller typed
 * by hand) and enforce the upstream per-request cap LOUDLY. Silently truncating
 * to the cap is the failure this exists to prevent: the caller gets a clean 200
 * covering a subset of what they asked about and no way to tell.
 */
function tickerList(v: unknown, field: string, max: number): string[] {
  const raw = Array.isArray(v)
    ? v.map((x) => String(x))
    : typeof v === 'string'
      ? v.split(',')
      : [];
  const list = raw.map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) {
    throw new Error(`Required argument "${field}" is missing or empty. Pass an array of tickers, e.g. ["KXHIGHNY-26SEP16-B75.5"].`);
  }
  if (list.length > max) {
    throw new Error(`"${field}" has ${list.length} entries but Kalshi accepts at most ${max} per request. Split the list and call again — nothing was truncated.`);
  }
  return list;
}

async function kalshiGet(path: string): Promise<unknown> {
  // Absolute URLs pass through (the search endpoint lives outside /trade-api/v2).
  const target = path.startsWith('http') ? path : `${BASE}${path}`;
  const res = PROXY
    ? await pwFetch(PROXY.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PROXY.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: target }),
      })
    : await pwFetch(target, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (res.status === 404) {
    return { error: 'not_found', message: 'Kalshi: ticker not found.' };
  }
  if (res.status === 429) {
    // Soft-fail instead of throwing. A single rate-limited sub-request must not
    // collapse a multi-call consumer (polymarket_kalshi_spread fans out across
    // several events + orderbooks) into a null result that surfaces as an
    // opaque "kalshi_unavailable" with no reason. Callers check the typed
    // field they asked for (.event/.markets/...) and degrade gracefully.
    return { error: 'rate_limited', message: 'Kalshi rate limit (HTTP 429). Try again in a minute.' };
  }
  if (!res.ok) {
    const t = await res.text();
    return { error: 'upstream_error', status: res.status, message: `Kalshi: ${res.status} ${t.slice(0, 200)}` };
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
