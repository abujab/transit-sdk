import { it, expect } from 'vitest';
import { TriasProvider } from '../src/index.js';
// Never run by default. The trusted workflow alone supplies this credential.
it('searches stops and plans departure and arrival journeys against MobiData BW', async () => {
  const key = process.env.TRIAS_REQUESTOR_KEY;
  if (!key) throw new Error('Trusted integration workflow requires its configured secret');
  const provider = new TriasProvider({ requestorKey: key });
  const origin = (await provider.searchStops('Stuttgart Hauptbahnhof'))[0];
  const destination = (await provider.searchStops('Esslingen Bahnhof'))[0];
  expect(Boolean(origin?.id && destination?.id)).toBe(true);
  for (const timeType of ['departure', 'arrival'] as const) {
    const journeys = await provider.planJourney({ origin: origin!.id, destination: destination!.id, time: new Date(Date.now() + 3600000), timeType });
    expect(journeys.length > 0).toBe(true);
    expect(journeys.every(j => j.legs.length > 0 && j.duration >= 0)).toBe(true);
  }
}, 60000);
