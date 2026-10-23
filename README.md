# Transit SDK

A reusable, ESM TypeScript SDK for public transport planning. The first adapter uses MobiData BW's [TRIAS endpoint](https://efa-bw.de/trias). Requires Node.js 22+ and a TRIAS requestor key issued by the provider.

## Build and use

This initial version is available from source; it has not been published to npm.

```sh
pnpm install --frozen-lockfile
pnpm build
```

```ts
import { TriasProvider, TransitError, type TransitProvider } from './dist/index.js';

// Supply your own key securely from your server's configuration.
// Do not embed keys in browser bundles or log request payloads.
const transit: TransitProvider = new TriasProvider({ requestorKey: serverConfig.triasKey });
const stops = await transit.searchStops('Stuttgart Hauptbahnhof', { limit: 5 });
const destinations = await transit.searchStops('Esslingen Bahnhof');
if (stops[0] && destinations[0]) {
  const journeys = await transit.planJourney({
    origin: stops[0].id,
    destination: destinations[0].id,
    time: new Date(),
    timeType: 'departure', // use 'arrival' for arrive-by searches
    limit: 5,
    maxTransfers: 2,
  });
  console.log(journeys);
}
```

## Architecture and results

`TransitProvider` defines `searchStops` and `planJourney`. Applications depend on this interface; another provider can implement it without importing TRIAS code. Provider stop IDs are opaque strings and should be reused only with the provider that issued them. The TRIAS adapter owns XML serialization, transport, and normalization; the core model is independent of XML.

Journeys contain ordered discriminated `transit` and `walk` legs, transfer counts, and total duration. Walks include access, egress, and interchanges. Durations are seconds, distances metres, coordinates WGS84 degrees, and timestamps ISO 8601 strings with timezones. Planned and estimated times/platforms stay separate; missing estimates mean realtime data was not supplied. Cancellation is mapped when reported by the service. Times and cancellations are snapshots and availability depends on upstream coverage.

The first version supports stop-to-stop planning and walking connections. It does not support fares, booking, accessibility guarantees, non-walking individual transport, or realtime subscriptions. Unsupported leg types fail explicitly rather than silently disappearing. No retries or caching occur automatically.

`TriasProvider` accepts an HTTPS `endpoint`, `timeoutMs` (default 15000), and injectable `fetch`. Both methods accept an `AbortSignal`. `TransitError.code` distinguishes `INVALID_ARGUMENT`, `NETWORK`, `HTTP`, `TIMEOUT`, `ABORTED`, `PARSE`, and `PROVIDER`; HTTP failures include `status`. Errors intentionally omit response bodies, raw transport causes, and credentials. Empty successful deliveries return empty arrays; provider errors throw.

## Development and validation

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm pack
```

Unit tests use synthetic XML and a dummy credential, never a live key. They cover search results, XML escaping, arrival/departure requests, walking and transfers, realtime data, invalid responses, provider/HTTP/network errors, cancellation, and timeouts.

CI runs on PRs without secrets. The separate **Trusted TRIAS integration** workflow is manually dispatched **on main after merge**. Its job requires this repository and `refs/heads/main`, checks out main explicitly, and supplies the existing `TRIAS_REQUESTOR_KEY` secret only to the integration test step. It never runs on `pull_request_target`, PR branches, or fork code. Never print the secret, enable HTTP debug logging, or upload request/response artifacts. Do not change this workflow to test untrusted code with credentials.

The integration smoke test searches real stops and plans both time directions. It requires available provider service and future timetable coverage. Passing unit tests alone does not establish live API compatibility. The secret is not accessed during local development or PR validation.
