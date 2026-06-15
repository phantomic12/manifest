import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';

export type IngestEventKind = 'message' | 'agent' | 'routing' | 'routing-decision';

export interface IngestEvent {
  userId: string;
  kind: IngestEventKind;
  /**
   * Optional payload attached to the event. Only used by 'routing-decision'
   * events today, which carry the live RoutingDecision snapshot for the
   * SSE-driven live-routing-monitor panel. Other kinds (message/agent/routing)
   * remain pure refetch triggers with no payload.
   */
  payload?: unknown;
}

@Injectable()
export class IngestEventBusService implements OnModuleDestroy {
  private readonly subject = new Subject<IngestEvent>();
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DEBOUNCE_MS = 250;

  /**
   * Notify subscribers that the given user's data changed. The kind narrows
   * which dashboard surfaces should refetch — message-feed pages can ignore
   * routing config updates and vice-versa, avoiding the previous "any change
   * refetches every open page" cascade.
   *
   * 'routing-decision' events bypass the debounce and fire synchronously
   * because they carry a live RoutingDecision payload that the
   * live-routing-monitor panel renders immediately. Coalescing 250ms worth
   * of decisions would defeat the point of a "live" monitor.
   */
  emit(userId: string, kind: IngestEventKind = 'message', payload?: unknown): void {
    if (kind === 'routing-decision') {
      this.subject.next(payload === undefined ? { userId, kind } : { userId, kind, payload });
      return;
    }

    const debounceKey = `${userId}:${kind}`;
    const existing = this.debounceTimers.get(debounceKey);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      debounceKey,
      setTimeout(() => {
        this.debounceTimers.delete(debounceKey);
        this.subject.next({ userId, kind });
      }, this.DEBOUNCE_MS),
    );
  }

  forUser(userId: string): Observable<IngestEvent> {
    return this.subject.asObservable().pipe(filter((e: IngestEvent) => e.userId === userId));
  }

  all(): Observable<IngestEvent> {
    return this.subject.asObservable();
  }

  onModuleDestroy(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.subject.complete();
  }
}
