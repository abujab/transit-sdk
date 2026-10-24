import { it, expect } from 'vitest';
import { TriasProvider, TransitError } from '../src/index.js';
// Main-only trusted workflow supplies the credential. Never print requests or bodies.
it('searches stops and plans departure and arrival journeys against MobiData BW', async () => {
  const key = process.env.TRIAS_REQUESTOR_KEY;
  if (!key) throw new Error('Trusted integration workflow requires its configured secret');
  const provider = new TriasProvider({ requestorKey: key, endpoint: process.env.TRIAS_ENDPOINT || undefined });
  let phase = 'origin stop search';
  try {
    const origin = (await provider.searchStops('Mannheim Hauptbahnhof'))[0];
    phase = 'destination stop search';
    const destination = (await provider.searchStops('Heidelberg Hauptbahnhof'))[0];
    expect(Boolean(origin?.id && destination?.id)).toBe(true);
    for (const timeType of ['departure', 'arrival'] as const) {
      phase = `${timeType} journey planning`;
      const journeys = await provider.planJourney({ origin: origin!.id, destination: destination!.id, time: new Date(Date.now() + 15 * 60000), timeType, maxTransfers: 2 });
      expect(journeys.length > 0).toBe(true);
      expect(journeys.every(j => j.legs.length > 0 && j.duration >= 0)).toBe(true);
      // Estimates are optional. Check their shape only if the provider supplied them.
      for (const journey of journeys) for (const leg of journey.legs) {
        if (leg.type !== 'transit') continue;
        for (const call of [leg.departure, leg.arrival]) {
          expect(Number.isFinite(Date.parse(call.scheduledTime ?? ''))).toBe(true);
          if (call.estimatedTime) expect(Number.isFinite(Date.parse(call.estimatedTime))).toBe(true);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof TransitError)) throw error;
    const access = error.code === 'HTTP' && [401, 403].includes(error.status ?? 0);
    // Emit allowlisted metadata only. No endpoint, key, headers, bodies or raw causes.
    throw new Error(`TRIAS integration failed during ${phase}: ${error.code}${error.status ? ` ${error.status}` : ''}. ` +
      (access ? 'Access refused before XML parsing; verify provider endpoint, key authorization and runner gateway policy.' :
        error.code === 'PARSE' ? 'Successful HTTP response did not match expected TRIAS XML.' : 'See docs/trias-conformance.md for failure classification.'));
  }
}, 90000);
