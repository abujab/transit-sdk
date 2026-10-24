import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { TriasProvider } from '../src/index.js';
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
function mock(xml: string, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(xml, { status }));
  return { provider: new TriasProvider({ requestorKey: 'schema-test-placeholder', fetch }), fetch };
}
const query = { origin: 'de:08222:2417', destination: 'de:08221:1160', time: new Date('2026-10-24T10:00:00Z'), timeType: 'departure' as const };
const payload = (body: unknown) => parser.parse(String(body)).Trias.ServiceRequest.RequestPayload;
describe('TRIAS 1.2 provider', () => {
  it('maps LocationInformationResponse/LocationResult with repeated names and coordinates', async () => {
    expect(await mock(fixture('location-single')).provider.searchStops('Mannheim')).toEqual([
      { id: 'de:08222:2417', name: 'Mannheim, Hauptbahnhof', longitude: 8.469, latitude: 49.479 },
    ]);
    const { provider, fetch } = mock(fixture('locations'));
    expect(await provider.searchStops('A&B<', { limit: 3 })).toHaveLength(2);
    expect(payload(fetch.mock.calls[0]?.[1]?.body).LocationInformationRequest).toEqual({
      InitialInput: { LocationName: 'A&B<' }, Restrictions: { Type: 'stop', NumberOfResults: '3' },
    });
    expect(fetch.mock.calls[0]?.[1]?.body).toContain('<LocationName>A&amp;B&lt;</LocationName>');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://efa-bw.de/trias');
  });
  it('excludes unresolved locations that cannot be used in trip requests', async () => {
    const xml = fixture('location-single').replace('<Complete>true</Complete>', '<Complete>false</Complete>');
    expect(await mock(xml).provider.searchStops('Mannheim')).toEqual([]);
  });
  it.each(['departure', 'arrival'] as const)('places %s time and InterchangeLimit in the correct XML locations', async timeType => {
    const { provider, fetch } = mock(fixture('trip-realtime'));
    await provider.planJourney({ ...query, timeType, maxTransfers: 2 });
    const request = payload(fetch.mock.calls[0]?.[1]?.body).TripRequest;
    expect(request.Params).toEqual({ NumberOfResults: '5', IgnoreRealtimeData: 'false', InterchangeLimit: '2', IncludeIntermediateStops: 'true' });
    expect(request[timeType === 'departure' ? 'Origin' : 'Destination'].DepArrTime).toBe('2026-10-24T10:00:00.000Z');
    expect(request[timeType === 'departure' ? 'Destination' : 'Origin'].DepArrTime).toBeUndefined();
    expect(request.Origin.LocationRef).toEqual({ StopPointRef: query.origin, LocationName: { Text: query.origin } });
    expect(request.Destination.LocationRef.StopPointRef).toBe(query.destination);
    const body = String(fetch.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain('NumberOfInterchanges');
    expect(body).not.toContain('IncludeRealtimeData');
    expect(body).not.toContain('Authorization');
    const envelope = parser.parse(body).Trias.ServiceRequest;
    expect(envelope.RequestorRef).toBe('schema-test-placeholder');
  });
  it('keeps the same location request structure as the official example subset', async () => {
    const { provider, fetch } = mock(fixture('locations-empty'));
    await provider.searchStops('Ravensburg', { limit: 40 });
    const example = parser.parse(fixture('example-location-request')).Trias.ServiceRequest.RequestPayload.LocationInformationRequest;
    const request = payload(fetch.mock.calls[0]?.[1]?.body).LocationInformationRequest;
    expect(request.InitialInput.LocationName).toBe(example.InitialInput.LocationName);
    expect(request.Restrictions).toEqual({ Type: example.Restrictions.Type, NumberOfResults: example.Restrictions.NumberOfResults });
  });
  it('uses the official example trip Origin/Destination reference structure', async () => {
    const { provider, fetch } = mock(fixture('trips-empty'));
    await provider.planJourney(query);
    const example = parser.parse(fixture('example-trip-request')).Trias.ServiceRequest.RequestPayload.TripRequest;
    const request = payload(fetch.mock.calls[0]?.[1]?.body).TripRequest;
    for (const side of ['Origin', 'Destination']) {
      expect(Object.keys(request[side].LocationRef)).toEqual(Object.keys(example[side].LocationRef));
      expect(request[side].LocationRef.StopPointRef).toBe(example[side].LocationRef.StopPointRef);
    }
    expect(request.Params.InterchangeLimit).toBeUndefined();
  });
  it.each(['trip-realtime', 'mentz-trip-realtime'])('maps realtime fields, cancellations, transfers and walking from %s', async name => {
    const [journey] = await mock(fixture(name)).provider.planJourney(query);
    expect(journey).toMatchObject({ id: 'trip-1', transfers: 1, duration: 3000, departureTime: '2026-10-24T10:00:00Z', arrivalTime: '2026-10-24T10:50:00Z' });
    expect(journey?.legs.map(l => l.type)).toEqual(['walk', 'transit', 'walk', 'transit']);
    expect(journey?.legs[0]).toEqual({ type: 'walk', duration: 300, distance: 300 });
    expect(journey?.legs[2]).toEqual({ type: 'walk', duration: 300, distance: 120 });
    expect(journey?.legs[1]).toMatchObject({ cancelled: false, line: 'S1', mode: 'rail', destination: 'Heidelberg',
      departure: { scheduledTime: '2026-10-24T10:05:00Z', estimatedTime: '2026-10-24T10:07:00Z', platform: '1', estimatedPlatform: '2' },
      arrival: { scheduledTime: '2026-10-24T10:25:00Z', estimatedTime: '2026-10-24T10:27:00Z' },
    });
    expect(journey?.legs[3]).toMatchObject({ cancelled: true }); // xs:boolean also permits "1".
  });
  it('does not fabricate estimates or cancellation when realtime data is absent', async () => {
    const [journey] = await mock(fixture('trip-scheduled')).provider.planJourney(query);
    const leg = journey?.legs[0];
    expect(leg?.type).toBe('transit');
    if (leg?.type !== 'transit') throw new Error('Expected transit fixture');
    expect(leg.cancelled).toBe(false);
    expect(leg.departure.estimatedTime).toBeUndefined();
    expect(leg.arrival.estimatedTime).toBeUndefined();
    expect(leg.departure.estimatedPlatform).toBeUndefined();
    expect(leg.departure.scheduledTime).toBe('2026-10-24T10:05:00Z');
  });
  it('recognizes all XML boolean cancellation representations', async () => {
    for (const value of ['true', '1', 'false', '0']) {
      const xml = fixture('trip-realtime').replace('<Cancelled>1</Cancelled>', `<Cancelled>${value}</Cancelled>`);
      const [journey] = await mock(xml).provider.planJourney(query);
      expect(journey?.legs[3]).toMatchObject({ cancelled: ['true', '1'].includes(value) });
    }
  });
  it('accepts empty successful response elements', async () => {
    expect(await mock(fixture('locations-empty')).provider.searchStops('x')).toEqual([]);
    expect(await mock(fixture('trips-empty')).provider.planJourney(query)).toEqual([]);
  });
  it.each([
    ['location-single', 'LocationInformationResponse', 'LocationInformationDelivery'],
    ['trip-scheduled', 'TripResponse', 'TripDelivery'],
  ])('rejects the old incorrect response wrapper in %s', async (name, correct, old) => {
    const xml = fixture(name).replaceAll(correct, old);
    const provider = mock(xml).provider;
    await expect(name.startsWith('location') ? provider.searchStops('x') : provider.planJourney(query)).rejects.toMatchObject({ code: 'PARSE' });
  });
  it('accepts explicitly prefixed TRIAS response elements', async () => {
    const xml = fixture('location-single')
      .replace('xmlns="http://www.vdv.de/trias"', 'xmlns:t="http://www.vdv.de/trias"')
      .replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)(?=[\s>])/g, '<$1t:$2');
    expect(await mock(xml).provider.searchStops('x')).toHaveLength(1);
  });
  it.each(['<broken', '<html/>', '<!DOCTYPE x><Trias/>'])('rejects malformed or unexpected successful XML', async xml => {
    await expect(mock(xml).provider.searchStops('x')).rejects.toMatchObject({ code: 'PARSE' });
  });
  it.each([401, 403, 502])('classifies HTTP %s before reading or parsing a response body', async status => {
    const response = new Response('<html>access denied; private diagnostic</html>', { status });
    const read = vi.spyOn(response, 'text');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const provider = new TriasProvider({ requestorKey: 'schema-test-placeholder', fetch });
    await expect(provider.searchStops('x')).rejects.toMatchObject({ code: 'HTTP', status });
    expect(read).not.toHaveBeenCalled();
  });
  it('does not confuse provider errors in HTTP 200 with gateway failures', async () => {
    await expect(mock(fixture('provider-error')).provider.planJourney(query)).rejects.toMatchObject({ code: 'PROVIDER' });
    const xml = fixture('locations-empty').replace('<siri:Status>true</siri:Status>', '<siri:Status>0</siri:Status>');
    await expect(mock(xml).provider.searchStops('x')).rejects.toMatchObject({ code: 'PROVIDER' });
  });
  it('redacts transport errors', async () => {
    const provider = new TriasProvider({ requestorKey: 'schema-test-placeholder', fetch: vi.fn().mockRejectedValue(new Error('schema-test-placeholder')) });
    await expect(provider.searchStops('x')).rejects.toMatchObject({ code: 'NETWORK', message: 'TRIAS transport failed' });
  });
  it('rejects schema-invalid zero, negative and fractional parameters before transport', async () => {
    const { provider, fetch } = mock('');
    await expect(provider.searchStops(' ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(provider.planJourney({ ...query, time: new Date('invalid') })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    for (const value of [0, -1, 1.5, NaN]) {
      await expect(provider.searchStops('x', { limit: value })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(provider.planJourney({ ...query, maxTransfers: value })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(provider.planJourney({ ...query, limit: value })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports cancellation and timeout separately', async () => {
    const fetch: typeof globalThis.fetch = async (_, init) => new Promise((_, reject) => {
      if (init?.signal?.aborted) reject(new Error('aborted'));
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const provider = new TriasProvider({ requestorKey: 'schema-test-placeholder', timeoutMs: 10, fetch });
    await expect(provider.searchStops('x')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(provider.searchStops('x', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
