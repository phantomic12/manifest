import {
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
  UseFilters,
  Logger,
  HttpException,
} from '@nestjs/common';
import { Request, Response as ExpressResponse } from 'express';
import { randomUUID } from 'crypto';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { AgentKeyAuthGuard } from '../../otlp/guards/agent-key-auth.guard';
import { IngestionContext } from '../../otlp/interfaces/ingestion-context.interface';
import { ProxyService } from './proxy.service';
import { ProxyRateLimiter } from './proxy-rate-limiter';
import { ProviderClient } from './provider-client';
import { ProxyMessageRecorder } from './proxy-message-recorder';
import { ThoughtSignatureCache } from './thought-signature-cache';
import { ThinkingBlockCache } from './thinking-block-cache';
import { ReasoningContentCache } from './reasoning-content-cache';
import { classifyCaller } from './caller-classifier';
import { sanitizeRequestHeaders } from './request-headers';
import { createCaptureSink, CaptureSink } from './recording-capture';
import { AgentRecordingCacheService } from '../../common/services/agent-recording-cache.service';
import {
  buildMetaHeaders,
  handleProviderError,
  recordFallbackFailures,
  handleStreamResponse,
  handleNonStreamResponse,
  recordSuccess,
} from './proxy-response-handler';
import { ProxyExceptionFilter, isChatRenderingClient } from './proxy-exception.filter';
import { sendFriendlyResponse } from './proxy-friendly-response';
import { formatManifestError } from '../../common/errors/error-codes';
import type { ProxyApiMode } from './proxy-types';
import { ResponsesSseError } from './chatgpt-adapter';
import { sanitizeProviderError } from './proxy-error-sanitizer';
import {
  RoutingDecisionRecorder,
  RoutingDecision,
} from '../../common/services/routing-decision-recorder.service';
import type { RoutingMeta } from './proxy.service';
import { detectRequestModality } from './modality-detector';
import { isMultimodalOutputModality, type MultimodalOutputModality } from 'manifest-shared';
import { ResolveService } from '../resolve/resolve.service';

const MAX_SEEN_USERS = 10_000;
const SEEN_USER_TTL_MS = 24 * 60 * 60 * 1000;

@Controller('v1')
@Public()
@UseGuards(AgentKeyAuthGuard)
@UseFilters(ProxyExceptionFilter)
@SkipThrottle()
export class ProxyController {
  private readonly logger = new Logger(ProxyController.name);
  private readonly seenUsers = new Map<string, number>();

  constructor(
    private readonly proxyService: ProxyService,
    private readonly rateLimiter: ProxyRateLimiter,
    private readonly providerClient: ProviderClient,
    private readonly recorder: ProxyMessageRecorder,
    private readonly signatureCache: ThoughtSignatureCache,
    private readonly thinkingCache: ThinkingBlockCache,
    private readonly reasoningCache: ReasoningContentCache,
    private readonly recordingCache: AgentRecordingCacheService,
    private readonly decisionRecorder: RoutingDecisionRecorder,
    private readonly resolveService: ResolveService,
  ) {}

  @Get('models')
  models(): Record<string, unknown> {
    return {
      object: 'list',
      data: [
        {
          id: 'auto',
          object: 'model',
          type: 'model',
          display_name: 'Manifest Auto',
        },
      ],
      has_more: false,
      first_id: 'auto',
      last_id: 'auto',
    };
  }

  @Post('chat/completions')
  async chatCompletions(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.handleProxyRequest(req, res, 'chat_completions');
  }

  @Post('responses')
  async responses(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.handleProxyRequest(req, res, 'responses');
  }

  @Post('messages')
  async messages(
    @Req() req: Request & { ingestionContext: IngestionContext },
    @Res() res: ExpressResponse,
  ): Promise<void> {
    await this.handleProxyRequest(req, res, 'messages');
  }

  private async handleProxyRequest(
    req: Request & { ingestionContext: IngestionContext },
    res: ExpressResponse,
    apiMode: ProxyApiMode,
  ): Promise<void> {
    const { userId } = req.ingestionContext;
    const body = req.body as Record<string, unknown>;
    const sessionKey = (req.headers['x-session-key'] as string) || 'default';
    const traceId = this.extractTraceId(req);
    const callerAttribution = classifyCaller(req.headers);
    const requestHeaders = sanitizeRequestHeaders(req.headers);
    const isStream = body.stream === true;
    let headersSent = false;
    let slotAcquired = false;

    const recordingEnabled = await this.recordingCache.isRecording(req.ingestionContext.agentId);
    const capture: CaptureSink | undefined = recordingEnabled ? createCaptureSink() : undefined;

    const clientAbort = new AbortController();
    res.once('close', () => clientAbort.abort());
    const startTime = Date.now();

    try {
      this.rateLimiter.checkLimit(userId);
      this.rateLimiter.checkIpLimit(req.ip ?? '');
      this.rateLimiter.acquireSlot(userId);
      slotAcquired = true;
      const specificityOverride = req.headers['x-manifest-specificity'] as string | undefined;
      const { forward, meta, failedFallbacks } = await this.proxyService.proxyRequest({
        agentId: req.ingestionContext.agentId,
        userId,
        body,
        sessionKey,
        tenantId: req.ingestionContext.tenantId,
        agentName: req.ingestionContext.agentName,
        signal: clientAbort.signal,
        specificityOverride,
        headers: req.headers,
        apiMode,
      });

      // Multimodal detection: if the request body carries image/audio/
      // video content (or an explicit output_modality hint), classify
      // it. If the agent has a multimodal assignment configured, swap
      // the recorded `meta` to point at it so the live-routing-monitor
      // panel shows the multimodal model. The actual HTTP forward
      // still goes through the text-mode path (this PR is about the
      // routing category, not a new /v1/images/generations proxy).
      const modality = detectRequestModality(body);
      const effectiveMeta =
        isMultimodalOutputModality(modality) && meta.provider && meta.provider !== 'manifest'
          ? await this.applyMultimodalRouting(req.ingestionContext.agentId, modality, meta)
          : meta;

      // Fan the routing decision out to the live-routing-monitor panel
      // BEFORE we send the response so SSE subscribers see the decision
      // in lockstep with the bytes coming back. We skip the synthetic
      // friendly responses (provider === 'manifest') — there's no real
      // routing decision there, just an error message.
      if (effectiveMeta.provider && effectiveMeta.provider !== 'manifest') {
        this.recordRoutingDecision({
          userId,
          agentId: req.ingestionContext.agentId,
          meta: effectiveMeta,
          failedFallbacks: failedFallbacks?.length ?? 0,
        });
      }

      this.trackFirstProxyRequest(userId);

      const metaHeaders = buildMetaHeaders(meta);
      const providerResponse = forward.response;

      if (!providerResponse.ok) {
        const errorBody = await providerResponse.text();
        await handleProviderError(
          res,
          req.ingestionContext,
          meta,
          metaHeaders,
          providerResponse.status,
          errorBody,
          failedFallbacks,
          this.recorder,
          traceId,
          callerAttribution,
          requestHeaders,
        );
        return;
      }

      const fallbackSuccessTs = recordFallbackFailures(
        req.ingestionContext,
        meta,
        failedFallbacks,
        this.recorder,
        callerAttribution,
        requestHeaders,
      );

      let streamUsage = null;

      const shouldStreamResponse = isStream || meta.response_mode === 'stream';

      if (shouldStreamResponse && providerResponse.body) {
        headersSent = true;
        streamUsage = await handleStreamResponse(
          res,
          forward,
          meta,
          metaHeaders,
          this.providerClient,
          this.signatureCache,
          sessionKey,
          this.thinkingCache,
          apiMode,
          capture,
          this.reasoningCache,
        );
      } else {
        streamUsage = await handleNonStreamResponse(
          res,
          forward,
          meta,
          metaHeaders,
          this.providerClient,
          this.signatureCache,
          sessionKey,
          this.thinkingCache,
          apiMode,
          capture,
          this.reasoningCache,
        );
      }

      recordSuccess(
        req.ingestionContext,
        meta,
        streamUsage,
        fallbackSuccessTs,
        this.recorder,
        traceId,
        sessionKey,
        startTime,
        callerAttribution,
        requestHeaders,
        capture ? { capture, requestBody: body } : undefined,
      );
    } catch (err: unknown) {
      this.handleProxyError(
        err,
        req,
        res,
        clientAbort,
        headersSent,
        traceId,
        callerAttribution,
        requestHeaders,
      );
    } finally {
      if (slotAcquired) this.rateLimiter.releaseSlot(userId);
    }
  }

  private handleProxyError(
    err: unknown,
    req: Request & { ingestionContext: IngestionContext },
    res: ExpressResponse,
    clientAbort: AbortController,
    headersSent: boolean,
    traceId: string | undefined,
    callerAttribution: ReturnType<typeof classifyCaller>,
    requestHeaders: ReturnType<typeof sanitizeRequestHeaders>,
  ): void {
    if (clientAbort.signal.aborted) {
      if (!res.writableEnded) res.end();
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    const status =
      err instanceof ResponsesSseError
        ? err.status
        : err instanceof HttpException
          ? err.getStatus()
          : 500;
    const providerErrorBody = err instanceof ResponsesSseError ? err.body : message;
    this.logger.error(`Proxy error: ${message}`);

    this.recorder
      .recordProviderError(req.ingestionContext, status, providerErrorBody, {
        traceId,
        callerAttribution,
        requestHeaders,
      })
      .catch((e) => this.logger.warn(`Failed to record provider error: ${e}`));

    if (headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }

    if (err instanceof ResponsesSseError) {
      res.status(err.status).json({
        error: {
          message: sanitizeProviderError(err.status, err.body, process.env.NODE_ENV),
          type: 'upstream_error',
          status: err.status,
        },
      });
      return;
    }

    // Rate limit errors stay as HTTP 429 so clients can backoff
    if (status === 429) {
      const response = err instanceof HttpException ? err.getResponse() : message;
      res
        .status(429)
        .json(
          typeof response === 'string'
            ? { error: { message: response, type: 'proxy_error' } }
            : response,
        );
      return;
    }

    const isStream = (req.body as Record<string, unknown>)?.stream === true;
    if (isChatRenderingClient(req)) {
      const clientMessage = status >= 500 ? formatManifestError('M500') : message;
      sendFriendlyResponse(res, clientMessage, isStream);
      return;
    }

    // Tool/monitor caller — surface the real HTTP status with a structured
    // envelope so CI pipelines can detect failures instead of treating the
    // friendly stub as success.
    const errorMessage =
      status >= 500 ? 'Manifest encountered an internal error. Try again shortly.' : message;
    res.status(status).json({
      error: {
        message: errorMessage,
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
      },
    });
  }

  private extractTraceId(req: Request): string | undefined {
    const header = req.headers['traceparent'] as string | undefined;
    if (!header) return undefined;
    const parts = header.split('-');
    return parts.length >= 2 ? parts[1] : undefined;
  }

  private trackFirstProxyRequest(userId: string): void {
    const now = Date.now();
    if (this.seenUsers.has(userId)) return;
    this.evictExpiredUsers(now);
    if (this.seenUsers.size >= MAX_SEEN_USERS) {
      const oldest = this.seenUsers.keys().next().value as string;
      this.seenUsers.delete(oldest);
    }
    this.seenUsers.set(userId, now);
  }

  private recordRoutingDecision(args: {
    userId: string;
    agentId: string;
    meta: RoutingMeta;
    failedFallbacks: number;
  }): void {
    const { userId, agentId, meta, failedFallbacks } = args;
    // `primary` is the model the routing chain wanted first. When a
    // fallback succeeded, the original primary's identity is preserved
    // on `fallbackFromModel` / `primaryProvider`; otherwise the primary
    // IS the model that answered.
    const primary = meta.fallbackFromModel
      ? { provider: meta.primaryProvider ?? 'unknown', model: meta.fallbackFromModel }
      : { provider: meta.provider, model: meta.model, authType: meta.auth_type };
    const decision: RoutingDecision = {
      requestId: randomUUID(),
      ts: Date.now(),
      agentId,
      tier: meta.tier,
      primary,
      fallbacks: meta.fallbackRoutes ?? [],
      modality: meta.output_modality ?? 'text',
      responseMode: meta.response_mode === 'stream' ? 'stream' : 'non_stream',
      specificityCategory: meta.specificity_category,
      headerTierId: meta.header_tier_id,
      successModel: { provider: meta.provider, model: meta.model },
      failedFallbacks,
      confidence: meta.confidence,
      reason: meta.reason,
    };
    this.decisionRecorder.record(userId, decision);
  }

  /**
   * If the agent has a multimodal assignment for this modality, swap
   * the recorded `meta` to point at it. The actual HTTP forward still
   * uses the original text-mode `forward.response` — this PR is about
   * the routing category (which model would answer an image/audio/
   * video request), not a new proxy path. Returns the original `meta`
   * unchanged when no multimodal assignment is configured.
   *
   * The 'reason' field is rewritten to 'modality:<kind>' so the live
   * monitor (and any future analytics) can distinguish multimodal
   * resolutions from text-tier resolutions at a glance.
   */
  private async applyMultimodalRouting(
    agentId: string,
    modality: MultimodalOutputModality,
    currentMeta: RoutingMeta,
  ): Promise<RoutingMeta> {
    const mm = await this.resolveService.resolveForModality(agentId, modality);
    if (!mm || !mm.route) {
      this.logger.warn(
        `Multimodal request detected (modality=${modality}) for agent=${agentId} ` +
          `but no multimodal assignment configured — routing as text`,
      );
      return currentMeta;
    }
    return {
      ...currentMeta,
      model: mm.route.model,
      provider: mm.route.provider,
      auth_type: mm.route.authType,
      output_modality: modality,
      reason: `modality:${modality}`,
      tier: mm.tier,
      confidence: 1,
      fallbackRoutes: (mm.fallback_routes ?? []).map((r) => ({
        provider: r.provider,
        model: r.model,
        authType: r.authType,
      })),
    };
  }

  private evictExpiredUsers(now: number): void {
    for (const [key, timestamp] of this.seenUsers) {
      if (now - timestamp > SEEN_USER_TTL_MS) {
        this.seenUsers.delete(key);
      } else {
        break;
      }
    }
  }
}
