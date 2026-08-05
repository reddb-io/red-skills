# Ground truth: GitHub rate-limit mechanics per credential kind

Research for wayfinder ticket #3382 (map #3381). All claims cite GitHub's official
docs as of 2026-08-05. Primary sources:

- REST rate limits: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- GraphQL rate limits: <https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api>
- `/rate_limit` endpoint: <https://docs.github.com/en/rest/rate-limit/rate-limit>
- REST best practices: <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- Webhook types: <https://docs.github.com/en/webhooks/types-of-webhooks>
- Webhook best practices: <https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks>
- Failed-delivery recovery: <https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries>
- `gh webhook forward`: <https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing>

## Summary table — primary buckets and limits

| Credential kind | REST primary limit | Bucket identity | GraphQL points/h |
|---|---|---|---|
| Unauthenticated | 60/h | per originating IP | n/a (auth required) |
| Classic PAT | 5,000/h | **the user's shared bucket** | 5,000 |
| Fine-grained PAT | 5,000/h | **the user's shared bucket** (docs do not distinguish it from classic for rate limiting) | 5,000 |
| OAuth app token (user-authorized) | 5,000/h; 15,000/h if the app is owned by a GitHub Enterprise Cloud org | **the user's shared bucket** | 5,000 (10,000 EC-owned app) |
| GitHub App **user access token** | 5,000/h; 15,000/h if the app is owned by an Enterprise Cloud org | **the user's shared bucket** | 5,000 (10,000 EC) |
| GitHub App **installation token** | 5,000/h base, scaling to a 12,500/h cap; 15,000/h flat on Enterprise Cloud orgs | **its own bucket, per installation** | 5,000 base → 12,500 cap; 10,000 on EC |
| GitHub Actions `GITHUB_TOKEN` (GraphQL) | — | per repository | 1,000/h per repo (15,000 for enterprise resources) |

**The one structural fact:** every user-flavored credential — classic PAT,
fine-grained PAT, OAuth app token, GitHub App user access token — draws from the
*same* 5,000/h bucket keyed to the user. Adding more PATs for the same user buys
nothing. The only credential with its **own** bucket is the GitHub App
**installation** token (per installation).
Source: rate-limits doc, "Primary rate limits" sections for each auth mode.

## Installation-token scaling (exact current rules)

- Base: **5,000 requests/h** per installation.
- Installations on an org with **more than 20 repositories** get **+50/h per repository**.
- Installations on an org with **more than 20 users** get **+50/h per user**.
- Hard cap from scaling: **12,500/h**.
- Installations on a **GitHub Enterprise Cloud** org: **15,000/h** (REST; GraphQL is 10,000 points/h on EC).

Source: rate-limits doc, "Primary rate limits for GitHub App installations";
GraphQL doc for the point-denominated equivalents.

## Headers and the `/rate_limit` endpoint

Every REST and GraphQL response carries:

| Header | Meaning |
|---|---|
| `x-ratelimit-limit` | max requests (REST) / points (GraphQL) per hour |
| `x-ratelimit-remaining` | remaining in the current window |
| `x-ratelimit-used` | used in the current window |
| `x-ratelimit-reset` | window reset time, UTC epoch seconds |
| `x-ratelimit-resource` | which bucket the request hit (`core`, `search`, `graphql`, …) |

GraphQL specifics: the primary limit is denominated in **points**, not requests.
Cost = estimated node-fetch count across nested connections ÷ 100, rounded,
minimum **1 point** per call. The `rateLimit` object (`limit`, `remaining`,
`used`, `resetAt`) can be queried inline, but the docs say to prefer the
response headers over spending a query. `x-ratelimit-resource` is always
`graphql` for GraphQL calls — GraphQL and REST core are **separate buckets**.

`GET /rate_limit`: "Accessing this endpoint does not count against your REST API
rate limit." It reports all buckets under `resources`: `core`, `search`,
`code_search`, `graphql`, `integration_manifest`, `dependency_snapshots`,
`code_scanning_upload`, `actions_runner_registration`, etc. So a budget-aware
client can poll it freely.

## Conditional requests / 304 semantics

Confirmed, verbatim from the best-practices doc: "Making a conditional request
does not count against your primary rate limit if a `304` response is returned."
Send `if-none-match` with the stored `ETag` (or `if-modified-since`).

Caveats:

- The waiver is stated for the **primary** limit only. A 304 is still an HTTP
  request: it occupies a slot in the 100-concurrent-request cap and the docs do
  not state it is exempt from secondary (points/minute, CPU-time) accounting.
  At GET = 1 secondary point, this only matters at extreme request rates.
- Conditional requests only help on endpoints that return `ETag`/`Last-Modified`;
  a changed resource costs a normal request.

## Secondary rate limits

Triggers (any of, REST + GraphQL combined where noted):

- **> 100 concurrent requests** (shared across REST and GraphQL).
- **> 900 points/min** against a single REST endpoint — GET/HEAD/OPTIONS = 1 point, POST/PATCH/PUT/DELETE = 5 points.
- **> 2,000 points/min** on the GraphQL API.
- **> 90 s CPU time per 60 s real time** (of which max 60 s for GraphQL).
- **> 80 content-generating requests/min** or **> 500 content-generating requests/h** (creating issues, comments, PRs, …).
- **> 2,000 OAuth access-token requests/h**.

Signals: `403` or `429` with a "secondary rate limit" message; possibly a
`retry-after` header. Primary exhaustion is distinguishable by
`x-ratelimit-remaining: 0`.

Recommended backoff (best-practices doc): honor `retry-after` exactly; if
`x-ratelimit-remaining` is 0, sleep until `x-ratelimit-reset`; otherwise wait at
least one minute and back off exponentially on repeats. Preventively: make
requests **serially**, and wait **at least one second between mutating
requests**. Continuing to hammer while limited can extend the ban.

## Webhook delivery options for a local host-scoped daemon (~5–30 repos)

1. **`gh webhook forward`** — CLI extension (`gh extension install cli/gh-webhook`)
   that creates a temporary repo or org webhook and forwards deliveries to a
   local URL (`gh webhook forward --repo=R --events=E --url=http://localhost:…`).
   Org mode needs the `admin:org_hook` scope; repo mode needs webhook-admin
   rights on the repo. **Hard limits, verbatim:** "Webhook forwarding is only
   designed for use during testing and development", "not supported for use in
   production environments", and "Only one person can use webhook forwarding at
   a time for each repository and organization." Repo/org webhooks only. →
   Dev-loop tool, not a daemon transport.
2. **GitHub App webhook** — one webhook per app, auto-delivers events from every
   repo the app is installed on; pairs with the installation token's own
   rate-limit bucket; deliveries are listable and programmatically redeliverable
   via the app-webhook deliveries API. Requires a publicly reachable HTTPS
   endpoint (i.e. a tunnel/relay for a local daemon). → Best production shape
   for 5–30 repos: one endpoint, one config, own budget, recovery API.
3. **Repository webhooks** — up to 20 per event per repo, needs admin on each
   repo; N repos = N webhook configs to create and rotate; same public-endpoint
   requirement; per-repo deliveries API exists. → Workable but O(N) management.
4. **No public endpoint at all** — poll with conditional requests: 304s are free
   against the primary limit, and `/rate_limit` is free to watch. The webhook
   best-practices doc itself frames webhooks as the way to "stay within the API
   rate limit", but for a strictly local daemon, ETag polling is the
   zero-infrastructure fallback.

Delivery semantics to design for: respond `2XX` within **10 seconds** or the
delivery is marked failed; redelivered events reuse the same
`X-GitHub-Delivery` id, so consumers must be idempotent; missed deliveries are
recovered by scripting the list-deliveries + redeliver endpoints (repo, org,
and app variants exist; none for Marketplace/Sponsors).
