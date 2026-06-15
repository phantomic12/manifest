import { IngestEventBusService } from './ingest-event-bus.service';
import { firstValueFrom, take, toArray } from 'rxjs';
import { RoutingDecisionRecorder, RoutingDecision } from './routing-decision-recorder.service';

describe('RoutingDecisionRecorder', () => {
  let bus: IngestEventBusService;
  let recorder: RoutingDecisionRecorder;

  const sampleDecision = (overrides: Partial<RoutingDecision> = {}): RoutingDecision => ({
    requestId: 'req-1',
    ts: 1_700_000_000_000,
    agentId: 'agent-1',
    tier: 'medium',
    primary: { provider: 'openai', model: 'gpt-4o' },
    fallbacks: [{ provider: 'anthropic', model: 'claude-haiku-4' }],
    modality: 'text',
    responseMode: 'stream',
    failedFallbacks: 0,
    confidence: 0.7,
    reason: 'medium complexity',
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers();
    bus = new IngestEventBusService();
    recorder = new RoutingDecisionRecorder(bus);
  });

  afterEach(() => {
    recorder.onModuleDestroy();
    bus.onModuleDestroy();
    jest.useRealTimers();
  });

  it('records a decision and exposes it via recent()', () => {
    const d = sampleDecision();
    recorder.record('user-1', d);
    expect(recorder.recent('user-1')).toEqual([d]);
  });

  it('returns a fresh array on every recent() call (no aliasing)', () => {
    const d = sampleDecision();
    recorder.record('user-1', d);
    const a = recorder.recent('user-1');
    const b = recorder.recent('user-1');
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
    a.push(sampleDecision({ requestId: 'intruder' }));
    expect(recorder.recent('user-1')).toEqual([d]);
  });

  it('isolates decisions per user', () => {
    const d1 = sampleDecision({ requestId: 'r1' });
    const d2 = sampleDecision({ requestId: 'r2' });
    recorder.record('user-1', d1);
    recorder.record('user-2', d2);
    expect(recorder.recent('user-1')).toEqual([d1]);
    expect(recorder.recent('user-2')).toEqual([d2]);
  });

  it('evicts the oldest entries past the ring buffer cap (200)', () => {
    for (let i = 0; i < 250; i++) {
      recorder.record('user-1', sampleDecision({ requestId: `r${i}` }));
    }
    const recent = recorder.recent('user-1');
    expect(recent).toHaveLength(200);
    // Newest 200 should be r50..r249
    expect(recent[0].requestId).toBe('r50');
    expect(recent[199].requestId).toBe('r249');
  });

  it('stream(userId) sees decisions recorded via the recorder', async () => {
    const sub = recorder.stream('user-1').pipe(take(2), toArray());
    const promise = firstValueFrom(sub);

    recorder.record('user-1', sampleDecision({ requestId: 'a' }));
    recorder.record('user-2', sampleDecision({ requestId: 'b' })); // filtered out
    recorder.record('user-1', sampleDecision({ requestId: 'c' }));

    const received = await promise;
    expect(received.map((d) => d.requestId)).toEqual(['a', 'c']);
  });

  it('raw bus.emit for routing-decision does NOT populate the buffer (only record() does)', () => {
    // The bus is the SSE fan-out channel, not the buffer's source of truth.
    // record() is the canonical write path; bus.emit is for ad-hoc
    // debugging or external publishers that don't care about backfill.
    const payload = sampleDecision({ requestId: 'via-bus' });
    bus.emit('user-1', 'routing-decision', payload);
    expect(recorder.recent('user-1')).toEqual([]);
  });
});
