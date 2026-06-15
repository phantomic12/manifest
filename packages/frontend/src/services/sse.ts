import { createSignal } from 'solid-js';

// pingCount counts ANY event from the bus (legacy back-compat for callers that
// don't care which kind fired). New code should depend on the targeted
// signals so a routing-only change doesn't refetch the message log etc.
const [pingCount, setPingCount] = createSignal(0);
const [messagePing, setMessagePing] = createSignal(0);
const [agentPing, setAgentPing] = createSignal(0);
const [routingPing, setRoutingPing] = createSignal(0);

/**
 * Live-routing-monitor state. Each new 'routing-decision' SSE message
 * pushes a fresh RoutingDecision onto the ring buffer (capped at 200)
 * and bumps the signal so Solid effects re-render. The buffer is
 * kept on the client because the bus is firehose-only — a freshly-opened
 * dashboard tab would otherwise see nothing for the first 30s.
 */
export interface RoutingDecision {
  requestId: string;
  ts: number;
  agentId: string;
  tier: string;
  primary: { provider: string; model: string; authType?: string } | null;
  fallbacks: Array<{ provider: string; model: string; authType?: string }>;
  modality: 'text' | 'image' | 'audio' | 'video';
  responseMode: 'stream' | 'non_stream';
  specificityCategory?: string;
  headerTierId?: string;
  successModel?: { provider: string; model: string };
  failedFallbacks: number;
  confidence: number;
  reason: string;
}

const ROUTING_BUFFER_CAP = 200;
const [routingDecisions, setRoutingDecisions] = createSignal<RoutingDecision[]>([]);

export { pingCount, messagePing, agentPing, routingPing, routingDecisions };

export function connectSse(): () => void {
  const es = new EventSource('/api/v1/events');

  const bumpPing = () => setPingCount((n) => n + 1);

  // Coalesce message-class bumps. A chatty agent emits one SSE `message` event
  // per ingested record, and every bump refetches the Overview/MessageLog
  // resources. Collapsing a burst into a single bump every 500ms keeps backend
  // QPS sane at the cost of a small refresh delay on the dashboard.
  let messageBumpTimer: ReturnType<typeof setTimeout> | null = null;
  const bumpMessagePing = () => {
    if (messageBumpTimer) return;
    messageBumpTimer = setTimeout(() => {
      messageBumpTimer = null;
      setMessagePing((n) => n + 1);
    }, 500);
  };

  // Legacy generic 'ping' from older deployments — keep listening so a partial
  // upgrade (old backend, new frontend) still triggers refetches. The safe
  // default is to treat unknown 'ping' as a message-class change since that's
  // the kind the bus emitted before typed events landed.
  es.addEventListener('ping', () => {
    bumpMessagePing();
    bumpPing();
  });

  es.addEventListener('message', () => {
    bumpMessagePing();
    bumpPing();
  });
  es.addEventListener('agent', () => {
    setAgentPing((n) => n + 1);
    bumpPing();
  });
  es.addEventListener('routing', () => {
    setRoutingPing((n) => n + 1);
    bumpPing();
  });

  // 'routing-decision' carries a JSON-serialized RoutingDecision in the
  // SSE data field. Each arrival is appended to a client-side ring
  // buffer (capped at ROUTING_BUFFER_CAP) so the live-routing-monitor
  // panel can backfill on freshly-opened tabs. We don't bump any of the
  // refetch signals here — the panel reads the buffer signal directly.
  es.addEventListener('routing-decision', (e: MessageEvent) => {
    try {
      const decision = JSON.parse(e.data) as RoutingDecision;
      setRoutingDecisions((current) => {
        const next =
          current.length >= ROUTING_BUFFER_CAP
            ? current.slice(current.length - ROUTING_BUFFER_CAP + 1)
            : current.slice();
        next.push(decision);
        return next;
      });
    } catch {
      // Malformed decision — drop on the floor. Don't spam the console;
      // a transient parse failure shouldn't take the SSE listener down.
    }
  });

  return () => {
    if (messageBumpTimer) clearTimeout(messageBumpTimer);
    messageBumpTimer = null;
    es.close();
  };
}
