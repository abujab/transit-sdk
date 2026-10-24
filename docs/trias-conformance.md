# TRIAS 1.2 conformance review (2026-10-24)

## Official references

The implementation was checked against these downloads from the [MobiData BW TRIAS dataset](https://mobidata-bw.de/de/dataset/trias):

| Reference | Findings used here |
| --- | --- |
| [MobiData BW factsheet](https://www.mobidata-bw.de/data/MobiData-BW-Factsheet-TRIAS.pdf), edition 05/26, pp. 3, 7, 9 | POST XML envelope, SIRI RequestorRef, InterchangeLimit, IgnoreRealtimeData, customer endpoint/access provisioning |
| [Mentz data-model documentation](https://www.mobidata-bw.de/data/Mentz_Datenmodellbeschreibung.pdf), dated 07.10.2024, pp. 2–4 | Request/response XPaths, LocationResult, TripResult, realtime call and service fields |
| [VDV TRIAS XSD 1.2 archive](https://www.mobidata-bw.de/dataset/3e6eb9a8-f119-4fdf-901a-7aab53a662dc/resource/920ff914-8813-45d4-b268-1084e9c7241d/download/trias-xsd-v1.2.zip) | Exact XML namespaces, sequence order, required elements and types |
| [Downloadable example requests](https://www.mobidata-bw.de/data/Beispielrequests.zip) | Stop-reference trip planning and name/coordinate location search |

Downloaded archive/document SHA-256 values:

| File | SHA-256 |
| --- | --- |
| XSD ZIP | `30b1a8e43a315bd833d8f558bd8e014a9eae4c01283428794dcca65eeb47ee77` |
| Example ZIP | `760492ac5652555f64709dca09384955a363db9ad77ac9c6f73d02e7f3d75af9` |
| Factsheet PDF | `cc6746f36d3459eb6daa13396f57e5b7c4eff987864f7e2ef34377382264653f` |
| Mentz PDF | `38f9b4adf29c1c5f91eb29ef65e14f1def3c593ecb9b60c847709da71c2be012` |

## Corrections and schema constraints

- Stop results: `Trias/ServiceDelivery/DeliveryPayload/LocationInformationResponse/LocationResult/Location/StopPoint` (or `StopPlace`). Ignore locations explicitly marked incomplete; they require another refinement request before use in planning.
- Journey results: `Trias/ServiceDelivery/DeliveryPayload/TripResponse/TripResult/Trip`.
- Transfer constraint: `TripRequest/Params/InterchangeLimit`, after base policy fields such as `NumberOfResults` and `IgnoreRealtimeData`, before content fields such as `IncludeIntermediateStops`. `NumberOfInterchanges` is not in the schema.
- `LocationRefStructure` requires `LocationName` after its stop reference. The SDK currently accepts IDs only, so it repeats the opaque ID as the required text; routing still uses `StopPointRef`. Acceptance of this fallback by the live provider remains to be checked.
- `NumberOfResults` and `InterchangeLimit` use `xs:positiveInteger`. Limits accept 1–100; maxTransfers accepts 1–20 (SDK bounds). Zero is now rejected instead of generating schema-invalid XML. In particular, the SDK does not currently offer a schema-conforming zero-transfer filter.
- XML authentication remains `ServiceRequest/siri:RequestorRef`; timestamps are `siri:RequestTimestamp`. No authentication headers or query-string credentials were introduced.

## Examples and profile differences

The official downloads are useful examples but are not all strictly valid against the downloadable XSD. We did not modify the XSD to accommodate them.

The two adapted request fixtures in `test/fixtures/example-*.xml` retain their source structures, with these explicit changes:

1. Replace the public, space-containing placeholder `IHR REQUESTOR-KEY` with the non-secret NMTOKEN `schema-test-placeholder`.
2. Qualify the trip example's `RequestTimestamp` with the SIRI namespace, as in the factsheet.
3. Remove `Restrictions/Language` from the location example; it is absent from `LocationParamStructure` in this XSD.
4. Move `IncludeLegProjection` before `IncludeIntermediateStops` in the trip example to satisfy the XSD sequence.
5. Remove the stale `xsi:schemaLocation` hint pointing to a v1.1 local directory. Validation explicitly loads the downloaded 1.2 schema.

All response fixtures are synthetic realistic messages constructed from the documented paths, not live captures. The official example ZIP supplies requests, not recorded responses. `trip-realtime.xml` and `trip-scheduled.xml` conform to the unmodified VDV XSD, including its required `ServiceSection`. `mentz-trip-realtime.xml` uses the flat `Service/LineRef`, `Service/Mode`, and `Service/PublishedLineName` documented by Mentz. That profile does **not** validate against this XSD: the validator explicitly checks the expected ServiceSection discrepancy. Both are parsed and tested. A service with multiple sections currently uses the first section's line/mode; changes along a single leg are not represented by the core model.

## Realtime behavior

Trip requests explicitly send the documented `IgnoreRealtimeData=false`. Do not substitute stop-event-only `IncludeRealtimeData`. The generic VDV XSD also defines `IncludeEstimatedTimes`, but the MobiData factsheet and Mentz request table do not list it as a supported TripRequest parameter; this adapter does not depend on that optional flag.

`LegBoard/ServiceDeparture` and `LegAlight/ServiceArrival` keep `TimetabledTime` and `EstimatedTime` separate. Planned and estimated bays remain separate; for repeated international text, the first supplied language is selected. Missing estimates remain undefined, never copied from the timetable. Service cancellation accepts both XSD boolean true spellings (`true` and `1`); missing, `false` and `0` map to false. A missing cancellation flag means cancellation was not reported, not proof that the service will run. The fixtures exercise delays, arrival estimates, changed platforms, cancellation and scheduled-only data. Interchange walking-leg duration includes its documented total duration (including buffer), rather than only WalkDuration.

The SDK does not expose every realtime attribute (for example stop-specific no-boarding flags or situation texts). It does not promise complete disruption reporting or automatic replanning. Availability of estimates and cancellations in near-term live data remains provider-dependent.

## Reproducible offline validation

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
# Python 3 and lxml are required for standards validation only, not SDK runtime.
python3 -m pip install lxml==6.0.2
pnpm test:schema
```

`test:schema` downloads the pinned official XSD archive, verifies its checksum and validates 16 documents: 9 schema-conforming fixtures and 7 requests generated by the actual SDK with an injected, non-network transport and dummy credential. Generated requests cover stop search, both time directions, and omitted/positive interchange limits. Five negative controls prove the schema rejects the old response names, the old interchange name, an interchange limit outside Params, and a zero interchange limit. The separate MENTZ fixture's known schema disagreement is also asserted. CI runs this without secrets. Runtime parsing checks XML well-formedness and expected response elements, not full XSD validity.

An already downloaded archive can be used without network access (its checksum is still verified):

```sh
pnpm build
python3 scripts/validate-xsd.py --schema-archive /path/to/trias-xsd-v1.2.zip
```

## HTTP 403 investigation

The [trusted integration run 40103445020](https://github.com/abujab/transit-sdk/actions/runs/40103445020) failed on the first stop search, before any journey request. Its serialized error is `code: HTTP, status: 403`. The adapter checks HTTP status before reading the response body, so the response-name bugs cannot explain that parsing-independent failure. A malformed request could still be rejected by a gateway; these observations do not exclude request-policy checks.

A separate credential-free probe on 2026-10-24, from this cloud environment, received HTTP 403 with HTML content type for a POST using the adapted official location example and a dummy RequestorRef; GET received HTTP 404. Neither response had an authentication challenge. This is consistent with access refusal but does not identify the component that refused it. The dummy-key result cannot establish whether the real key is valid or authorized, whether the GitHub runner is allowed, or whether the same gateway handled both requests. Response bodies and raw requests were not printed or retained. A GET probe does not test the POST API's schema or health.

The factsheet describes customer-specific endpoint and authentication provisioning. Verify that the provisioned key is active, has access to TRIAS 1.2 and is paired with the correct endpoint; confirm any gateway/source-IP restrictions with MobiData BW. Do not infer a new authentication mechanism from 403 or automatically move the key into headers. These are unresolved possibilities, not established causes. We did not access the repository secret or contact the provider.

Error classification and safe diagnostics:

| Failure | SDK result |
| --- | --- |
| HTTP 401/403, including HTML or empty body | `HTTP` with status and access-refusal guidance; body never parsed |
| Other non-success HTTP, e.g. 502 | `HTTP` with status; body never parsed |
| HTTP success with malformed XML/unexpected response structure | `PARSE` |
| HTTP success with TRIAS/SIRI error status or ErrorMessage | `PROVIDER` |
| Transport, timeout, user cancellation | `NETWORK`, `TIMEOUT`, `ABORTED` |

The integration test now reports only the operation phase, error code and numeric HTTP status, with an access-refusal hint for 401/403. It does not log endpoint URLs, credentials, headers, raw requests/responses or transport causes. The trusted workflow may use the optional repository variable `TRIAS_ENDPOINT` for the provider-issued HTTPS endpoint; absence preserves `https://efa-bw.de/trias`. The existing secret remains confined to the manual, main-only integration workflow, with main explicitly checked out. No PR workflow receives it.

After merge, dispatch that workflow on main to verify successful authentication, acceptance of the ID-based LocationName fallback, real stop/journey results in both time directions, and enforcement of InterchangeLimit. Check near-term journeys for estimates/platform changes and any reported cancellations without requiring realtime fields to exist for every journey. The smoke test validates fields when present; it cannot prove realtime coverage or transfer-limit enforcement across the network. Resolving any remaining 403 requires the authorized endpoint/key pairing and, potentially, provider-side gateway diagnostics. No successful live integration is claimed by this PR.
