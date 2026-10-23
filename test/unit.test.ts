import { describe, it, expect, vi } from 'vitest';
import { TriasProvider } from '../src/index.js';
const wrap = (xml: string) => `<Trias xmlns="http://www.vdv.de/trias"><ServiceDelivery><DeliveryPayload>${xml}</DeliveryPayload></ServiceDelivery></Trias>`;
const location = `<LocationInformationDelivery><Location><Location><StopPoint><StopPointRef>001</StopPointRef><StopPointName><Text>Hbf &amp; City</Text></StopPointName></StopPoint><GeoPosition><Longitude>9.18</Longitude><Latitude>48.78</Latitude></GeoPosition></Location></Location></LocationInformationDelivery>`;
const call = (kind: string, id: string) => `<Leg${kind === 'Departure' ? 'Board' : 'Alight'}><StopPointRef>${id}</StopPointRef><StopPointName><Text>Station</Text></StopPointName><Service${kind}><TimetabledTime>2026-10-23T10:00:00Z</TimetabledTime><EstimatedTime>2026-10-23T10:02:00Z</EstimatedTime></Service${kind}><PlannedBay><Text>1</Text></PlannedBay><EstimatedBay><Text>2</Text></EstimatedBay></Leg${kind === 'Departure' ? 'Board' : 'Alight'}>`;
const timed = `<TripLeg><TimedLeg>${call('Departure', '001')}${call('Arrival', '002')}<Service><PublishedLineName><Text>S1</Text></PublishedLineName><Mode><PtMode>rail</PtMode></Mode><Cancelled>true</Cancelled></Service></TimedLeg></TripLeg>`;
const trip = `<TripDelivery><TripResult><ResultId>r1</ResultId><Trip><TripId>t1</TripId><Duration>PT1H5M</Duration><StartTime>2026-10-23T10:00:00Z</StartTime><EndTime>2026-10-23T11:05:00Z</EndTime><Interchanges>1</Interchanges><TripLeg><ContinuousLeg><Duration>PT5M</Duration><Length>300</Length><Service><IndividualMode>walk</IndividualMode></Service></ContinuousLeg></TripLeg>${timed}<TripLeg><InterchangeLeg><Duration>PT2M</Duration></InterchangeLeg></TripLeg>${timed}</Trip></TripResult></TripDelivery>`;
function mock(xml: string, status = 200) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(xml, { status }));
  return { provider: new TriasProvider({ requestorKey: 'test-only-key', fetch }), fetch };
}
const query = { origin: '001', destination: '002', time: new Date('2026-10-23T10:00:00Z'), timeType: 'departure' as const };
describe('TRIAS provider', () => {
  it('maps singleton stops, preserves identifiers and coordinates', async () => {
    const { provider, fetch } = mock(wrap(location));
    expect(await provider.searchStops('A&B<', { limit: 3 })).toEqual([{ id: '001', name: 'Hbf & City', latitude: 48.78, longitude: 9.18 }]);
    expect(fetch.mock.calls[0]?.[1]?.body).toContain('<LocationName>A&amp;B&lt;</LocationName>');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://efa-bw.de/trias');
  });
  it.each(['departure', 'arrival'] as const)('places %s time on the correct endpoint', async timeType => {
    const { provider, fetch } = mock(wrap(trip));
    const result = await provider.planJourney({ ...query, timeType, maxTransfers: 2 });
    const body = String(fetch.mock.calls[0]?.[1]?.body);
    const endpoint = timeType === 'departure' ? 'Origin' : 'Destination';
    expect(body).toMatch(new RegExp(`<${endpoint}>.*<DepArrTime>2026-10-23T10:00:00.000Z</DepArrTime></${endpoint}>`));
    expect(body.match(/<DepArrTime>/g)).toHaveLength(1);
    expect(body).toContain('<NumberOfInterchanges>2</NumberOfInterchanges>');
    expect(result[0]).toMatchObject({ id: 't1', transfers: 1, duration: 3900 });
    expect(result[0]?.legs.map(l => l.type)).toEqual(['walk', 'transit', 'walk', 'transit']);
    expect(result[0]?.legs[0]).toEqual({ type: 'walk', duration: 300, distance: 300 });
    expect(result[0]?.legs[1]).toMatchObject({ cancelled: true, line: 'S1', departure: { estimatedTime: '2026-10-23T10:02:00Z', platform: '1', estimatedPlatform: '2' } });
  });
  it('accepts empty results', async () => {
    expect(await mock(wrap('<LocationInformationDelivery/>')).provider.searchStops('x')).toEqual([]);
    expect(await mock(wrap('<TripDelivery/>')).provider.planJourney(query)).toEqual([]);
  });
  it('normalizes repeated stops', async () => {
    const twice = location.replace('</LocationInformationDelivery>', location.replace(/<\/?LocationInformationDelivery>/g, '') + '</LocationInformationDelivery>');
    expect(await mock(wrap(twice)).provider.searchStops('x')).toHaveLength(2);
  });
  it.each(['<broken', '<html/>', '<!DOCTYPE x><Trias/>'])('rejects malformed or unexpected XML', async xml => {
    await expect(mock(xml).provider.searchStops('x')).rejects.toMatchObject({ code: 'PARSE' });
  });
  it('handles HTTP errors without reflecting bodies', async () => {
    await expect(mock('sensitive body', 401).provider.searchStops('x')).rejects.toMatchObject({ code: 'HTTP', status: 401, message: 'TRIAS HTTP request failed' });
  });
  it('handles provider errors', async () => {
    await expect(mock(wrap('<TripDelivery><ErrorMessage>private detail</ErrorMessage></TripDelivery>')).provider.planJourney(query)).rejects.toMatchObject({ code: 'PROVIDER' });
  });
  it('redacts transport errors', async () => {
    const provider = new TriasProvider({ requestorKey: 'test-only-key', fetch: vi.fn().mockRejectedValue(new Error('test-only-key')) });
    await expect(provider.searchStops('x')).rejects.toMatchObject({ code: 'NETWORK', message: 'TRIAS transport failed' });
  });
  it('validates inputs before transport', async () => {
    const { provider, fetch } = mock('');
    await expect(provider.searchStops(' ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(provider.planJourney({ ...query, time: new Date('invalid') })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(provider.searchStops('x', { limit: -1 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports cancellation and timeout separately', async () => {
    const fetch: typeof globalThis.fetch = async (_, init) => new Promise((_, reject) => {
      if (init?.signal?.aborted) reject(new Error('aborted'));
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const provider = new TriasProvider({ requestorKey: 'test-only-key', timeoutMs: 10, fetch });
    await expect(provider.searchStops('x')).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(provider.searchStops('x', { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
