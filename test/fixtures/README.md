# Fixture provenance

See [the conformance review](../../docs/trias-conformance.md) for source links, download hashes, explicit adaptations and known profile differences.

- `example-location-request.xml`: adapted MobiData BW LocationInformationRequest – GeoPosition_LocationName example.
- `example-trip-request.xml`: adapted MobiData BW TripRequest – StopPointRef example.
- All other XML: synthetic realistic responses based on the Mentz paths and VDV XSD; none are live captures.
- `mentz-trip-realtime.xml` deliberately follows the documented flat MENTZ service model. It is tested by the parser but has a known VDV ServiceSection schema mismatch. All other XML files pass the official unmodified XSD.
- Every request uses a visibly non-secret dummy placeholder. No fixtures contain credentials or personal data.
