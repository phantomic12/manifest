import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { IngestEventBusService, IngestEvent } from './ingest-event-bus.service';

/**
 * Snapshot of one resolved routing decision. Carried on the
 * 'routing-decision' bus event so the live-routing-monitor panel can
 * render what the proxy just routed to, in real time.
 */
export interface RoutingDecision {
  /** uuid v4 — ties the primary-attempt + any successful fallback together. */
  requestId: string;
  /** Date.now() at decision time (recorder.record call). */
  ts: number;
  agentId: string;
  tier: string;
  primary: { provider: string; model: string; authType?: string } | null;
  fallbacks: Array<{ provider: string; model: string; authType?: string }>;
  modality: 'text' | 'image' | 'audio' | 'video';
  responseMode: 'stream' | 'non_stream';
  specificityCategory?: string;
  headerTierId?: string;
  /** Which model actually answered (the fallback if a fallback succeeded). */
  successModel?: { provider: string; model: string };
  failedFallbacks: number;
  confidence: number;
  reason: string;
}

/**
 * In-memory ring buffer of the last 200 routing decisions per user.
 *
 * Why a service instead of just a bus subscriber:
 *  - New SSE clients (a freshly-opened dashboard tab) want to backfill
 *    the last N decisions so the panel isn't empty for the first 30s.
 *  - The bus alone is firehose-only — late subscribers get nothing.
 *
 * The recorder's `record(userId, decision)` writes to the buffer and
 * then emits a 'routing-decision' event on the bus so SSE subscribers
 * see the new decision live. We do NOT also subscribe to the bus for
 * 'routing-decision' (that would be a self-feedback loop) — the
 * `stream()` method just exposes the bus's routing-decision stream
 * filtered to one user. The bus is the SSE fan-out channel, NOT the
 * buffer's source of truth; use `record()` as the canonical write path.
 */
@Injectable()
export class RoutingDecisionRecorder implements OnModuleDestroy {
  private static readonly CAPACITY = 200;
  private readonly buffers = new Map<string, RoutingDecision[]>();

  constructor(private readonly bus: IngestEventBusService) {}

  onModuleDestroy(): void {
    this.buffers.clear();
  }

  /**
   * Append a decision to the user's ring buffer AND fan it out via
   * the bus so SSE subscribers (live-routing-monitor panels on open
   * dashboard tabs) see the new decision immediately.
   */
  record(userId: string, decision: RoutingDecision): void {
    this.push(userId, decision);
    this.bus.emit(userId, 'routing-decision', decision);
  }

  /**
   * Most recent decisions for a user, newest last. Returns a fresh
   * array on every call so callers can mutate it without poisoning
   * the buffer.
   */
  recent(userId: string): RoutingDecision[] {
    const buf = this.buffers.get(userId);
    return buf ? [...buf] : [];
  }

  /**
   * Observable of routing decisions for a user, filtered to that user.
   * Late subscribers see only decisions that arrive after they
   * subscribe (use `recent()` for the historical backfill).
   */
  stream(userId: string): Observable<RoutingDecision> {
    return this.bus.forUser(userId).pipe(
      filter((e: IngestEvent) => e.kind === 'routing-decision'),
      map((e: IngestEvent) => e.payload as RoutingDecision),
    );
  }

  private push(userId: string, decision: RoutingDecision): void {
    let buf = this.buffers.get(userId);
    if (!buf) {
      buf = [];
      this.buffers.set(userId, buf);
    }
    buf.push(decision);
    if (buf.length > RoutingDecisionRecorder.CAPACITY) {
      buf.splice(0, buf.length - RoutingDecisionRecorder.CAPACITY);
    }
  }
}
