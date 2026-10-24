import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { TransitError, type TransitProvider, type Stop, type Journey, type JourneyQuery, type RequestOptions, type Call, type Leg } from './model.js';
export interface TriasOptions { requestorKey: string; endpoint?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch }
// Untyped optional and repeating XML elements are confined to this adapter.
type Xml = any;
const array = (v: Xml): Xml[] => v == null ? [] : Array.isArray(v) ? v : [v];
const text = (v: Xml): string => String(v?.Text ?? v ?? '');
const escape = (v: string): string => v.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const parser = new XMLParser({ removeNSPrefix: true, parseTagValue: false });
function fail(): never { throw new TransitError('PARSE', 'Invalid TRIAS response'); }
function required(v: Xml): string { return text(v) || fail(); }
function duration(v: Xml): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text(v));
  if (!m) return fail();
  return Number(m[1] ?? 0)*86400 + Number(m[2] ?? 0)*3600 + Number(m[3] ?? 0)*60 + Number(m[4] ?? 0);
}
function stop(v: Xml): Stop { return { id: required(v.StopPointRef ?? v.StopPlaceRef), name: required(v.StopPointName ?? v.StopPlaceName) }; }
function call(v: Xml, kind: 'Departure' | 'Arrival'): Call {
  if (!v) return fail();
  const t = v[`Service${kind}`];
  return { stop: stop(v), scheduledTime: t?.TimetabledTime, estimatedTime: t?.EstimatedTime, platform: v.PlannedBay ? text(v.PlannedBay) : undefined, estimatedPlatform: v.EstimatedBay ? text(v.EstimatedBay) : undefined };
}
function integer(v: number | undefined, max: number): void {
  if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > max)) throw new TransitError('INVALID_ARGUMENT', `Expected an integer between 0 and ${max}`);
}
export class TriasProvider implements TransitProvider {
  private readonly transport: typeof globalThis.fetch;
  private readonly endpoint: string;
  private readonly timeout: number;
  private readonly key: string;
  constructor(options: TriasOptions) {
    if (!options.requestorKey?.trim()) throw new TransitError('INVALID_ARGUMENT', 'A requestor key is required');
    this.endpoint = options.endpoint ?? 'https://efa-bw.de/trias';
    if (new URL(this.endpoint).protocol !== 'https:') throw new TransitError('INVALID_ARGUMENT', 'Endpoint must use HTTPS');
    this.timeout = options.timeoutMs ?? 15000;
    if (!Number.isFinite(this.timeout) || this.timeout <= 0) throw new TransitError('INVALID_ARGUMENT', 'Timeout must be positive');
    this.transport = options.fetch ?? globalThis.fetch; this.key = options.requestorKey;
  }
  private async request(payload: string, options: RequestOptions = {}): Promise<Xml> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    try {
      const response = await this.transport(this.endpoint, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', Accept: 'application/xml' },
        body: `<?xml version="1.0" encoding="UTF-8"?><Trias version="1.2" xmlns="http://www.vdv.de/trias" xmlns:siri="http://www.siri.org.uk/siri"><ServiceRequest><siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp><siri:RequestorRef>${escape(this.key)}</siri:RequestorRef><RequestPayload>${payload}</RequestPayload></ServiceRequest></Trias>` });
      if (!response.ok) throw new TransitError('HTTP', 'TRIAS HTTP request failed', response.status);
      const xml = await response.text();
      if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) return fail();
      let root: Xml;
      try { root = parser.parse(xml)?.Trias?.ServiceDelivery; } catch { return fail(); }
      if (!root) return fail();
      if (root.Status === 'false' || root.ErrorMessage || root.ErrorCondition) throw new TransitError('PROVIDER', 'TRIAS rejected the request');
      return root.DeliveryPayload ?? fail();
    } catch (error) {
      if (options.signal?.aborted) throw new TransitError('ABORTED', 'Request cancelled');
      if (controller.signal.aborted) throw new TransitError('TIMEOUT', 'TRIAS request timed out');
      if (error instanceof TransitError) throw error;
      // Raw transport errors and response bodies may contain credentials.
      throw new TransitError('NETWORK', 'TRIAS transport failed');
    } finally { clearTimeout(timer); }
  }
  async searchStops(query: string, options: RequestOptions & { limit?: number } = {}): Promise<Stop[]> {
    if (!query.trim()) throw new TransitError('INVALID_ARGUMENT', 'Search query is required');
    integer(options.limit, 100);
    const result = await this.request(`<LocationInformationRequest><InitialInput><LocationName>${escape(query)}</LocationName></InitialInput><Restrictions><Type>stop</Type><NumberOfResults>${options.limit ?? 10}</NumberOfResults></Restrictions></LocationInformationRequest>`, options);
    const delivery = result.LocationInformationDelivery;
    if (delivery == null) return fail();
    if (delivery.ErrorMessage) throw new TransitError('PROVIDER', 'TRIAS stop search failed');
    return array(delivery.Location).filter(i => i.Location?.StopPoint || i.Location?.StopPlace).map(i => {
      const l = i.Location; const p = l.GeoPosition;
      return { ...stop(l.StopPoint ?? l.StopPlace), ...(p ? { latitude: Number(p.Latitude), longitude: Number(p.Longitude) } : {}) };
    });
  }
  async planJourney(query: JourneyQuery, options: RequestOptions = {}): Promise<Journey[]> {
    if (!query.origin?.trim() || !query.destination?.trim() || !(query.time instanceof Date) || !Number.isFinite(query.time.getTime()) || !['departure', 'arrival'].includes(query.timeType)) throw new TransitError('INVALID_ARGUMENT', 'Valid stops, time and timeType are required');
    integer(query.limit, 100); integer(query.maxTransfers, 20);
    const time = `<DepArrTime>${query.time.toISOString()}</DepArrTime>`;
    const endpoint = (id: string, t: string) => `<LocationRef><StopPointRef>${escape(id)}</StopPointRef></LocationRef>${t}`;
    const result = await this.request(`<TripRequest><Origin>${endpoint(query.origin, query.timeType === 'departure' ? time : '')}</Origin><Destination>${endpoint(query.destination, query.timeType === 'arrival' ? time : '')}</Destination><Params><NumberOfResults>${query.limit ?? 5}</NumberOfResults>${query.maxTransfers !== undefined ? `<NumberOfInterchanges>${query.maxTransfers}</NumberOfInterchanges>` : ''}<IncludeIntermediateStops>true</IncludeIntermediateStops></Params></TripRequest>`, options);
    const delivery = result.TripDelivery;
    if (delivery == null) return fail();
    if (delivery.ErrorMessage) throw new TransitError('PROVIDER', 'TRIAS journey planning failed');
    return array(delivery.TripResult).map(result => {
      if (result.ErrorMessage) throw new TransitError('PROVIDER', 'TRIAS journey result failed');
      const trip = result.Trip; if (!trip) return fail();
      const legs: Leg[] = array(trip.TripLeg).map(leg => {
        if (leg.TimedLeg) {
          const t = leg.TimedLeg; const s = t.Service; if (!s) return fail();
          return { type: 'transit', departure: call(t.LegBoard, 'Departure'), arrival: call(t.LegAlight, 'Arrival'), line: text(s.PublishedLineName ?? s.LineRef), mode: s.Mode?.PtMode, destination: s.DestinationText ? text(s.DestinationText) : undefined, cancelled: s.Cancelled === 'true' };
        }
        const w = leg.InterchangeLeg ?? leg.ContinuousLeg;
        if (!w || (leg.ContinuousLeg && w.Service?.IndividualMode !== 'walk')) return fail();
        return { type: 'walk', duration: duration(w.Duration), distance: w.Length == null ? undefined : Number(w.Length) };
      });
      return { id: required(trip.TripId ?? result.ResultId), duration: duration(trip.Duration), transfers: Number(trip.Interchanges ?? Math.max(0, legs.filter(l => l.type === 'transit').length - 1)), departureTime: required(trip.StartTime), arrivalTime: required(trip.EndTime), legs };
    });
  }
}
