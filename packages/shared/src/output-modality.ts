/**
 * Output modalities a routed request can target.
 *
 * - `text`: standard chat-completions path. Default for every existing
 *   assignment.
 * - `image`: image generation. Resolved when the request body contains
 *   image content blocks (e.g. OpenAI's `image_url`) or an explicit
 *   `output_modality: 'image'` hint.
 * - `audio`: speech synthesis or transcription. Resolved when the
 *   request body contains audio content blocks or an explicit
 *   `output_modality: 'audio'` hint.
 * - `video`: video generation. Resolved when the request body contains
 *   video content blocks or an explicit `output_modality: 'video'`
 *   hint.
 *
 * The `text` modality is always the default. The other three require a
 * matching modality assignment to be configured for the agent — without
 * one, multimodal requests fall back to the text path and the proxy
 * logs a warning so the dashboard surfaces the misconfiguration.
 */
export const OUTPUT_MODALITIES = ['text', 'image', 'audio', 'video'] as const;

export type OutputModality = (typeof OUTPUT_MODALITIES)[number];

export const DEFAULT_OUTPUT_MODALITY: OutputModality = 'text';

export const MULTIMODAL_OUTPUT_MODALITIES = ['image', 'audio', 'video'] as const;

export type MultimodalOutputModality = (typeof MULTIMODAL_OUTPUT_MODALITIES)[number];

export function isOutputModality(value: unknown): value is OutputModality {
  return typeof value === 'string' && (OUTPUT_MODALITIES as readonly string[]).includes(value);
}

export function isMultimodalOutputModality(value: unknown): value is MultimodalOutputModality {
  return (
    typeof value === 'string' && (MULTIMODAL_OUTPUT_MODALITIES as readonly string[]).includes(value)
  );
}
