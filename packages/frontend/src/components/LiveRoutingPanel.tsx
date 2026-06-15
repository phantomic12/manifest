import { For, Show, type Component } from 'solid-js';
import { routingDecisions, type RoutingDecision } from '../services/sse.js';

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

const tierColor = (tier: string): string => {
  // Matches the complexity-tier chip colors used elsewhere in the
  // dashboard (simple=green, medium=amber, hard=rose). Kept inline so
  // we don't depend on the routing-tiers stylesheet ordering.
  switch (tier) {
    case 'simple':
      return 'hsl(142 71% 45%)';
    case 'medium':
      return 'hsl(38 92% 50%)';
    case 'hard':
      return 'hsl(0 84% 60%)';
    case 'reasoning':
      return 'hsl(280 65% 60%)';
    default:
      return 'hsl(var(--muted-foreground))';
  }
};
const modalityLabel: Record<RoutingDecision['modality'], string> = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
};

const modalityColor: Record<RoutingDecision['modality'], string> = {
  text: 'hsl(var(--muted-foreground))',
  image: 'hsl(280 65% 60%)',
  audio: 'hsl(199 89% 48%)',
  video: 'hsl(15 90% 55%)',
};

const DecisionRow: Component<{ decision: RoutingDecision }> = (props) => {
  const success = () => props.decision.successModel;
  // Was the primary what answered, or did a fallback rescue the request?
  const fallbackUsed = () => props.decision.successModel?.model !== props.decision.primary?.model;
  const isMultimodal = () => props.decision.modality !== 'text';
  return (
    <div class="live-routing-row">
      <div class="live-routing-row__time">{formatTime(props.decision.ts)}</div>
      <div class="live-routing-row__tier">
        <span
          class="live-routing-tier-dot"
          style={{ background: tierColor(props.decision.tier) }}
        />
        {props.decision.tier}
      </div>
      <div class="live-routing-row__models">
        <Show when={isMultimodal()}>
          <span
            class="live-routing-modality-chip"
            style={{ color: modalityColor[props.decision.modality] }}
            title={`Modality: ${modalityLabel[props.decision.modality]}`}
          >
            {modalityLabel[props.decision.modality]}
          </span>
        </Show>
        <Show
          when={props.decision.primary}
          fallback={<span class="live-routing-no-route">no route</span>}
        >
          <span class="live-routing-model">
            {props.decision.primary!.provider}/{props.decision.primary!.model}
          </span>
        </Show>
        <Show when={fallbackUsed() && success()}>
          <span class="live-routing-arrow" aria-label="routed via fallback">
            →
          </span>
          <span class="live-routing-model live-routing-model--success">
            {success()!.provider}/{success()!.model}
          </span>
        </Show>
        <Show when={props.decision.failedFallbacks > 0}>
          <span class="live-routing-failed-badge" title="fallback attempts that errored">
            {props.decision.failedFallbacks} failed
          </span>
        </Show>
      </div>
    </div>
  );
};

const LiveRoutingPanel: Component = () => {
  // Newest first.
  const ordered = () => {
    const list = routingDecisions();
    return [...list].reverse();
  };
  return (
    <div class="live-routing-panel">
      <div class="live-routing-panel__header">
        <span class="live-routing-panel__title">Live routing</span>
        <span class="live-routing-panel__count">{routingDecisions().length} recent</span>
      </div>
      <Show
        when={routingDecisions().length > 0}
        fallback={
          <div class="live-routing-empty">Waiting for the first request to be routed&hellip;</div>
        }
      >
        <div class="live-routing-list" role="log" aria-live="polite" aria-relevant="additions">
          <For each={ordered()}>{(decision) => <DecisionRow decision={decision} />}</For>
        </div>
      </Show>
    </div>
  );
};

export default LiveRoutingPanel;
