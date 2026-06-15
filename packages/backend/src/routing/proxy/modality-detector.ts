import { isOutputModality, type OutputModality } from 'manifest-shared';

/**
 * Shape of a single message content block we care about. OpenAI's
 * chat-completions format uses an array of either string or
 * typed-content-block entries; we only need the `type` field for
 * detection.
 */
interface ContentBlock {
  type?: string;
}

/**
 * Walk the request body and decide which output modality to target.
 *
 * Detection order (most specific first):
 *   1. Explicit `body.output_modality` hint from the caller (a forward
 *      header or a body field). Trust it if it's a valid value.
 *   2. Last user message contains an `image_url` content block → `image`
 *   3. Last user message contains an `input_audio` content block → `audio`
 *   4. Last user message contains a `video_url` content block → `video`
 *   5. No signals → `text` (the default path)
 *
 * We deliberately only inspect the last user message. Multimodal
 * requests are typically a single turn with the media attached —
 * inspecting all messages risks misclassifying a text follow-up in a
 * long conversation that started with an image as a "fresh image
 * request" and routing it to a generation model. Last-message-only
 * keeps the heuristic conservative.
 */
export function detectRequestModality(body: unknown): OutputModality {
  if (!body || typeof body !== 'object') return 'text';
  const b = body as Record<string, unknown>;

  // 1. Explicit hint wins.
  if (isOutputModality(b.output_modality)) return b.output_modality;
  if (isOutputModality(b.modality)) return b.modality;

  // 2-4. Walk the last user message.
  const messages = Array.isArray(b.messages) ? b.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    if (!m || m.role !== 'user') continue;
    const content = m.content;
    if (Array.isArray(content)) {
      if (content.some((c) => blockIsImage(c))) return 'image';
      if (content.some((c) => blockIsAudio(c))) return 'audio';
      if (content.some((c) => blockIsVideo(c))) return 'video';
    }
    // First user message we found — stop scanning earlier ones.
    break;
  }

  return 'text';
}

function blockIsImage(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const t = (block as ContentBlock).type;
  return t === 'image_url' || t === 'image';
}

function blockIsAudio(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const t = (block as ContentBlock).type;
  return t === 'input_audio' || t === 'audio';
}

function blockIsVideo(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const t = (block as ContentBlock).type;
  return t === 'video_url' || t === 'video';
}
