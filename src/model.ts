/** Timestamps use ISO 8601 with timezone; durations are seconds. */
export interface Stop { id: string; name: string; latitude?: number; longitude?: number }
export interface Call { stop: Stop; scheduledTime?: string; estimatedTime?: string; platform?: string; estimatedPlatform?: string }
export interface TransitLeg { type: 'transit'; departure: Call; arrival: Call; line: string; mode?: string; destination?: string; cancelled: boolean }
export interface WalkingLeg { type: 'walk'; duration: number; distance?: number }
export type Leg = TransitLeg | WalkingLeg;
export interface Journey { id: string; duration: number; transfers: number; departureTime: string; arrivalTime: string; legs: Leg[] }
export interface JourneyQuery { origin: string; destination: string; time: Date; timeType: 'departure' | 'arrival'; limit?: number; maxTransfers?: number }
export interface RequestOptions { signal?: AbortSignal }
export interface TransitProvider {
  searchStops(query: string, options?: RequestOptions & { limit?: number }): Promise<Stop[]>;
  planJourney(query: JourneyQuery, options?: RequestOptions): Promise<Journey[]>;
}
export type ErrorCode = 'INVALID_ARGUMENT' | 'NETWORK' | 'HTTP' | 'TIMEOUT' | 'ABORTED' | 'PARSE' | 'PROVIDER';
export class TransitError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status?: number) { super(message); this.name = 'TransitError'; }
}
