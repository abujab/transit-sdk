// Offline only: no environment credentials and no network transport.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TriasProvider } from '../dist/index.js';
const directory = process.argv[2];
if (!directory) throw new Error('A temporary output directory is required');
let filename;
const provider = new TriasProvider({
  requestorKey: 'schema-test-placeholder',
  fetch: async (_, init) => {
    await writeFile(join(directory, filename), String(init.body));
    return new Response('<?xml version="1.0"?><Trias xmlns="http://www.vdv.de/trias"><ServiceDelivery><DeliveryPayload>' +
      (filename.startsWith('location') ? '<LocationInformationResponse/>' : '<TripResponse/>') +
      '</DeliveryPayload></ServiceDelivery></Trias>');
  },
});
filename = 'location-generated.xml';
await provider.searchStops('Mannheim & Heidelberg', { limit: 5 });
for (const timeType of ['departure', 'arrival']) {
  for (const maxTransfers of [undefined, 1, 2]) {
    filename = `trip-${timeType}-${maxTransfers ?? 'default'}-generated.xml`;
    await provider.planJourney({ origin: 'de:08222:2417', destination: 'de:08221:1160', time: new Date('2026-10-24T10:00:00Z'), timeType, maxTransfers });
  }
}
