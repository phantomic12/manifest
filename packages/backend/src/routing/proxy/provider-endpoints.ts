import { OLLAMA_CLOUD_HOST, OLLAMA_HOST } from '../../common/constants/ollama';
import { PROVIDER_BY_ID_OR_ALIAS } from '../../common/constants/providers';
import {
  CODEX_CLI_ORIGINATOR,
  CODEX_CLI_USER_AGENT,
  COPILOT_EDITOR_VERSION,
  COPILOT_PLUGIN_VERSION,
  buildClaudeCodeSubscriptionHeaders,
} from '../../common/constants/subscription-clients';
import { normalizeProviderBaseUrl } from '../provider-base-url';
import { getQwenCompatibleBaseUrl } from '../qwen-region';
import { getXiaomiTokenPlanBaseUrl } from '../xiaomi-region';
import { getZaiCodingPlanBaseUrl } from '../zai-region';
import { buildKiroHeaders, KIRO_BASE_URL, KIRO_CHAT_TARGET } from './kiro-adapter';

export interface ProviderEndpoint {
  baseUrl: string;
  buildHeaders: (apiKey: string, authType?: string) => Record<string, string>;
  buildPath: (model: string) => string;
  /**
   * Per-modality upstream paths. When the proxy is dispatching a
   * multimodal request (image / audio / video), it calls the matching
   * builder instead of `buildPath`. If the endpoint doesn't override
   * one, the proxy falls back to the OpenAI-standard paths
   * (`/v1/images/generations`, `/v1/audio/speech`,
   * `/v1/videos/generations`).
   *
   * Image-gen + speech + video-gen endpoints take a fundamentally
   * different body shape from chat-completions (no `messages` array,
   * no `stream` flag, different parameter names) so the proxy passes
   * the request body through verbatim. The shape delta is the
   * caller's responsibility — OpenAI's docs are the spec.
   */
  buildImagePath?: (model: string) => string;
  buildAudioPath?: (model: string) => string;
  buildVideoPath?: (model: string) => string;
  /**
   * Optional override used when the request is a stream. Some upstreams
   * (notably the CodeAssist API) expose a separate `:streamGenerateContent`
   * method instead of accepting `?alt=sse` on the non-streaming path. When
   * absent, the proxy falls back to `buildPath` and appends `?alt=sse` for
   * `format: 'google'` streams.
   */
  buildStreamPath?: (model: string) => string;
  format: 'openai' | 'google' | 'anthropic' | 'chatgpt' | 'kiro';
  /**
   * How this endpoint can report exact token usage for streaming responses.
   * `openai_stream_options` means the proxy should request a final usage event
   * by sending `stream_options.include_usage`.
   */
  streamUsageReporting?: 'openai_stream_options';
  /**
   * Set to `true` for endpoints whose `baseUrl` is user-supplied (custom
   * providers, subscription resource URLs). The proxy re-runs SSRF
   * validation against this URL immediately before each forward to defend
   * against DNS rebinding — the hostname might have resolved to a public
   * IP at registration time but rebinds to a private/metadata address at
   * forward time.
   */
  requiresSsrfRevalidation?: boolean;
  /**
   * When `true`, the proxy wraps the outgoing Google-shape request body in
   * the CodeAssist envelope (`{ model, project, request }`) and unwraps
   * `{ response }` from the upstream reply. The project id is read from
   * the OAuth blob's `u` field. Only valid alongside `format: 'google'`.
   */
  codeAssistEnvelope?: boolean;
  /**
   * Subscription routes using the Anthropic wire format usually need the
   * Claude-agent identity prompt. Disable it for API-key based third-party
   * endpoints that only reuse the Anthropic protocol shape.
   */
  skipSubscriptionIdentity?: boolean;
}

const openaiStreamUsage = { streamUsageReporting: 'openai_stream_options' as const };

const openaiHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
});

const openaiPath = () => '/v1/chat/completions';

const anthropicHeaders = (apiKey: string, authType?: string): Record<string, string> => {
  if (authType === 'subscription') {
    return buildClaudeCodeSubscriptionHeaders(apiKey);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  headers['x-api-key'] = apiKey;
  return headers;
};

const anthropicBearerHeaders = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
});

// Some Anthropic-compatible /v1/messages endpoints authenticate via the
// `x-api-key` header, not `Authorization: Bearer`.
const anthropicApiKeyHeaders = (apiKey: string): Record<string, string> => ({
  'x-api-key': apiKey,
  'Content-Type': 'application/json',
  'anthropic-version': '2023-06-01',
});

/**
 * ChatGPT subscription OAuth tokens use the Codex backend,
 * which requires specific headers to avoid 403 responses.
 * Note: These headers mimic the Codex CLI client. This is required for the
 * endpoint to accept requests, but may break if OpenAI changes validation.
 */
const CHATGPT_SUBSCRIPTION_BASE = 'https://chatgpt.com/backend-api';
const BYTEPLUS_CODING_BASE = 'https://ark.ap-southeast.bytepluses.com/api/coding';
const COMMAND_CODE_PROVIDER_BASE = 'https://api.commandcode.ai/provider';
const KIMI_CODING_SUBSCRIPTION_BASE = 'https://api.kimi.com/coding';
const MINIMAX_SUBSCRIPTION_BASE = 'https://api.minimax.io/anthropic';
const XIAOMI_MIMO_BASE = 'https://api.xiaomimimo.com';
const XIAOMI_TOKEN_PLAN_BASE = getXiaomiTokenPlanBaseUrl();
const QWEN_TOKEN_PLAN_BASE = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode';
const ZAI_SUBSCRIPTION_BASE = getZaiCodingPlanBaseUrl('global');
const OPENCODE_GO_BASE = 'https://opencode.ai/zen/go';
const OPENCODE_ZEN_BASE = 'https://opencode.ai/zen';
const KILO_GATEWAY_BASE = 'https://api.kilo.ai/api/gateway';
const NVIDIA_NIM_BASE = 'https://integrate.api.nvidia.com';
const FIREWORKS_INFERENCE_BASE = 'https://api.fireworks.ai/inference';
const GITLAWB_GATEWAY_BASE = 'https://opengateway.gitlawb.com';
const TOKENROUTER_BASE = 'https://api.tokenrouter.com';
const chatgptSubscriptionHeaders = (apiKey: string) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
  originator: CODEX_CLI_ORIGINATOR,
  'user-agent': CODEX_CLI_USER_AGENT,
});

export const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoint> = {
  openai: {
    baseUrl: 'https://api.openai.com',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'openai-subscription': {
    baseUrl: CHATGPT_SUBSCRIPTION_BASE,
    buildHeaders: chatgptSubscriptionHeaders,
    buildPath: () => '/codex/responses',
    format: 'chatgpt',
  },
  // Standard OpenAI API key against api.openai.com/v1/responses — used for
  // Codex, -pro, o1-pro, and deep-research models that reject /v1/chat/completions.
  'openai-responses': {
    baseUrl: 'https://api.openai.com',
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/responses',
    format: 'chatgpt',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    buildHeaders: anthropicHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  byteplus: {
    baseUrl: BYTEPLUS_CODING_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/v3/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  'byteplus-anthropic': {
    baseUrl: BYTEPLUS_CODING_BASE,
    buildHeaders: anthropicBearerHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
    skipSubscriptionIdentity: true,
  },
  commandcode: {
    baseUrl: COMMAND_CODE_PROVIDER_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'commandcode-anthropic': {
    baseUrl: COMMAND_CODE_PROVIDER_BASE,
    buildHeaders: anthropicApiKeyHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
    skipSubscriptionIdentity: true,
  },
  fireworks: {
    baseUrl: FIREWORKS_INFERENCE_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  kilo: {
    baseUrl: KILO_GATEWAY_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  mistral: {
    baseUrl: 'https://api.mistral.ai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  xai: {
    baseUrl: 'https://api.x.ai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'xai-responses': {
    baseUrl: 'https://api.x.ai',
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/responses',
    format: 'chatgpt',
  },
  minimax: {
    baseUrl: 'https://api.minimax.io',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'minimax-subscription': {
    baseUrl: MINIMAX_SUBSCRIPTION_BASE,
    buildHeaders: anthropicBearerHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
  },
  xiaomi: {
    baseUrl: XIAOMI_MIMO_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'xiaomi-subscription': {
    baseUrl: XIAOMI_TOKEN_PLAN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.ai',
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'moonshot-subscription': {
    baseUrl: KIMI_CODING_SUBSCRIPTION_BASE,
    buildHeaders: anthropicApiKeyHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
    skipSubscriptionIdentity: true,
  },
  nvidia: {
    baseUrl: NVIDIA_NIM_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  qwen: {
    baseUrl: getQwenCompatibleBaseUrl('beijing'),
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'qwen-subscription': {
    baseUrl: QWEN_TOKEN_PLAN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'qwen-subscription-responses': {
    baseUrl: QWEN_TOKEN_PLAN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/responses',
    format: 'chatgpt',
  },
  zai: {
    baseUrl: 'https://api.z.ai',
    buildHeaders: openaiHeaders,
    buildPath: () => '/api/paas/v4/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  'zai-subscription': {
    baseUrl: ZAI_SUBSCRIPTION_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    buildHeaders: (apiKey: string) => ({
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    }),
    buildPath: (model: string) => `/v1beta/models/${model}:generateContent`,
    format: 'google',
  },
  'gemini-subscription': {
    baseUrl: 'https://cloudcode-pa.googleapis.com',
    buildHeaders: (apiKey: string) => ({
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    }),
    buildPath: () => '/v1internal:generateContent',
    buildStreamPath: () => '/v1internal:streamGenerateContent',
    format: 'google',
    codeAssistEnvelope: true,
  },
  copilot: {
    baseUrl: 'https://api.githubcopilot.com',
    buildHeaders: (apiKey: string) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Editor-Version': COPILOT_EDITOR_VERSION,
      'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
      'Copilot-Integration-Id': 'vscode-chat',
    }),
    buildPath: () => '/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  'copilot-responses': {
    baseUrl: 'https://api.githubcopilot.com',
    buildHeaders: (apiKey: string) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Editor-Version': COPILOT_EDITOR_VERSION,
      'Editor-Plugin-Version': COPILOT_PLUGIN_VERSION,
      'Copilot-Integration-Id': 'vscode-chat',
    }),
    buildPath: () => '/responses',
    format: 'chatgpt',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai',
    buildHeaders: (apiKey: string) => ({
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://manifest.build',
      'X-Title': 'Manifest',
    }),
    buildPath: () => '/api/v1/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  ollama: {
    baseUrl: OLLAMA_HOST,
    buildHeaders: () => ({ 'Content-Type': 'application/json' }),
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'ollama-cloud': {
    baseUrl: OLLAMA_CLOUD_HOST,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  kiro: {
    baseUrl: KIRO_BASE_URL,
    buildHeaders: (apiKey: string) => buildKiroHeaders(apiKey, KIRO_CHAT_TARGET),
    buildPath: () => '/',
    format: 'kiro',
  },
  'opencode-go': {
    baseUrl: OPENCODE_GO_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  'opencode-go-anthropic': {
    baseUrl: OPENCODE_GO_BASE,
    buildHeaders: anthropicApiKeyHeaders,
    buildPath: () => '/v1/messages',
    format: 'anthropic',
  },
  'opencode-zen': {
    baseUrl: OPENCODE_ZEN_BASE,
    buildHeaders: openaiHeaders,
    buildPath: () => '/v1/chat/completions',
    format: 'openai',
    ...openaiStreamUsage,
  },
  'opencode-zen-google': {
    baseUrl: OPENCODE_ZEN_BASE,
    buildHeaders: (apiKey: string) => ({
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
    }),
    buildPath: (model: string) => `/v1/models/${model}:generateContent`,
    format: 'google',
  },
  gitlawb: {
    baseUrl: GITLAWB_GATEWAY_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
  tokenrouter: {
    baseUrl: TOKENROUTER_BASE,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
  },
};

/** Build a ProviderEndpoint for a custom provider with the given base URL. */
export function buildCustomEndpoint(
  baseUrl: string,
  apiKind: 'openai' | 'anthropic' = 'openai',
): ProviderEndpoint {
  const normalized = normalizeProviderBaseUrl(baseUrl);
  if (apiKind === 'anthropic') {
    return {
      baseUrl: normalized,
      buildHeaders: anthropicHeaders,
      buildPath: () => '/v1/messages',
      format: 'anthropic',
      requiresSsrfRevalidation: true,
    };
  }
  return {
    baseUrl: normalized,
    buildHeaders: openaiHeaders,
    buildPath: openaiPath,
    format: 'openai',
    ...openaiStreamUsage,
    requiresSsrfRevalidation: true,
  };
}

export function buildEndpointOverride(baseUrl: string, templateKey: string): ProviderEndpoint {
  const template = PROVIDER_ENDPOINTS[templateKey];
  if (!template) {
    throw new Error(`No provider endpoint template configured for: ${templateKey}`);
  }
  return {
    ...template,
    baseUrl: normalizeProviderBaseUrl(baseUrl),
    requiresSsrfRevalidation: true,
  };
}

/** Resolve a pricing-DB provider name to a provider endpoint key. */
export function resolveEndpointKey(provider: string): string | null {
  const lower = provider.toLowerCase();
  if (PROVIDER_ENDPOINTS[lower]) return lower;

  if (lower.startsWith('custom:')) return lower;

  const entry = PROVIDER_BY_ID_OR_ALIAS.get(lower);
  if (entry) {
    if (PROVIDER_ENDPOINTS[entry.id]) return entry.id;
    for (const alias of entry.aliases) {
      if (PROVIDER_ENDPOINTS[alias]) return alias;
    }
  }

  return null;
}
