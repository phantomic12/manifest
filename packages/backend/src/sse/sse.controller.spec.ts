import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { SseController } from './sse.controller';
import { IngestEventBusService, IngestEvent } from '../common/services/ingest-event-bus.service';

describe('SseController', () => {
  let controller: SseController;
  let mockSubject: Subject<IngestEvent>;

  beforeEach(async () => {
    mockSubject = new Subject<IngestEvent>();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SseController],
      providers: [
        {
          provide: IngestEventBusService,
          useValue: { forUser: jest.fn().mockReturnValue(mockSubject.asObservable()) },
        },
      ],
    }).compile();

    controller = module.get<SseController>(SseController);
  });

  it('throws UnauthorizedException when user is null', () => {
    expect(() => controller.events(null as never)).toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when user has no id', () => {
    expect(() => controller.events({} as never)).toThrow(UnauthorizedException);
  });

  it('fans each bus event into a typed event and a legacy ping', (done) => {
    const user = { id: 'user-1', name: 'Test', email: 'test@test.com' } as never;
    const stream$ = controller.events(user);
    const received: unknown[] = [];

    stream$.subscribe({
      next: (event) => {
        received.push(event);
        if (received.length === 6) {
          expect(received).toEqual([
            { type: 'message', data: 'message' },
            { type: 'ping', data: 'ping' },
            { type: 'agent', data: 'agent' },
            { type: 'ping', data: 'ping' },
            { type: 'routing', data: 'routing' },
            { type: 'ping', data: 'ping' },
          ]);
          done();
        }
      },
    });

    mockSubject.next({ userId: 'user-1', kind: 'message' });
    mockSubject.next({ userId: 'user-1', kind: 'agent' });
    mockSubject.next({ userId: 'user-1', kind: 'routing' });
  });

  it('forwards routing-decision payload as JSON in the data field', (done) => {
    const user = { id: 'user-1', name: 'Test', email: 'test@test.com' } as never;
    const stream$ = controller.events(user);
    const received: unknown[] = [];

    const decision = {
      requestId: 'req-1',
      ts: 1_700_000_000_000,
      agentId: 'agent-1',
      tier: 'medium',
      primary: { provider: 'OpenAI', model: 'gpt-4o' },
      fallbacks: [{ provider: 'Anthropic', model: 'claude-haiku-4' }],
      modality: 'text',
      responseMode: 'stream',
      failedFallbacks: 0,
      confidence: 0.7,
      reason: 'medium complexity',
    };

    stream$.subscribe({
      next: (event) => {
        received.push(event);
        if (received.length === 2) {
          expect(received[0]).toEqual({
            type: 'routing-decision',
            data: JSON.stringify(decision),
          });
          expect(received[1]).toEqual({ type: 'ping', data: 'ping' });
          done();
        }
      },
    });

    mockSubject.next({ userId: 'user-1', kind: 'routing-decision', payload: decision });
  });
});
