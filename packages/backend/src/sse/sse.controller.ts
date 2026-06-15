import { Controller, Sse, UnauthorizedException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { CurrentUser } from '../auth/current-user.decorator';
import { IngestEventBusService, IngestEvent } from '../common/services/ingest-event-bus.service';
import { AuthUser } from '../auth/auth.instance';

interface MessageEvent {
  data: string;
  type: string;
}

@Controller('api/v1')
export class SseController {
  constructor(private readonly eventBus: IngestEventBusService) {}

  @Sse('events')
  events(@CurrentUser() user: AuthUser): Observable<MessageEvent> {
    if (!user?.id) {
      throw new UnauthorizedException('Session required for SSE');
    }

    // Each bus event fans out as TWO SSE messages: the typed one (so new
    // clients can target by kind) AND the legacy 'ping' (so older frontends
    // listening on 'ping' still see every change during a partial upgrade).
    //
    // 'routing-decision' events carry a JSON-serialized RoutingDecision
    // payload in the typed message's data field, so the frontend can render
    // the live decision directly without a refetch. All other kinds still
    // send the kind string as data (no change from before).
    return this.eventBus.forUser(user.id).pipe(
      mergeMap((evt: IngestEvent) => {
        const typed: MessageEvent =
          evt.kind === 'routing-decision' && evt.payload !== undefined
            ? { type: evt.kind, data: JSON.stringify(evt.payload) }
            : { type: evt.kind, data: evt.kind };
        return [typed, { type: 'ping', data: 'ping' }];
      }),
    );
  }
}
