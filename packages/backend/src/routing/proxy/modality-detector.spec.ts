import { detectRequestModality } from './modality-detector';

describe('detectRequestModality', () => {
  it('returns "text" for a vanilla text-only request', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is the capital of France?' },
      ],
    };
    expect(detectRequestModality(body)).toBe('text');
  });

  it('returns "text" for a body with no messages array', () => {
    expect(detectRequestModality({})).toBe('text');
    expect(detectRequestModality(null)).toBe('text');
    expect(detectRequestModality(undefined)).toBe('text');
  });

  it('returns "image" when the last user message has an image_url content block', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg' } },
          ],
        },
      ],
    };
    expect(detectRequestModality(body)).toBe('image');
  });

  it('returns "audio" when the last user message has an input_audio content block', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'transcribe this' },
            { type: 'input_audio', input_audio: { data: 'base64...' } },
          ],
        },
      ],
    };
    expect(detectRequestModality(body)).toBe('audio');
  });

  it('returns "video" when the last user message has a video_url content block', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'video_url', video_url: { url: 'https://example.com/clip.mp4' } },
          ],
        },
      ],
    };
    expect(detectRequestModality(body)).toBe('video');
  });

  it('honors an explicit output_modality hint over content detection', () => {
    const body = {
      output_modality: 'audio',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    };
    expect(detectRequestModality(body)).toBe('audio');
  });

  it('ignores invalid output_modality hints and falls back to content detection', () => {
    const body = {
      output_modality: 'hologram',
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
    };
    expect(detectRequestModality(body)).toBe('image');
  });

  it('ignores non-user messages when scanning for media content', () => {
    const body = {
      messages: [
        // An assistant message earlier in the conversation had an image
        // — maybe a tool result. A fresh user follow-up should not
        // misclassify the request as image.
        { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
        { role: 'user', content: 'thanks!' },
      ],
    };
    expect(detectRequestModality(body)).toBe('text');
  });

  it('only inspects the last user message, not earlier ones in a long conversation', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] },
        { role: 'assistant', content: 'looks like a cat' },
        { role: 'user', content: 'now write a poem about cats' },
      ],
    };
    expect(detectRequestModality(body)).toBe('text');
  });
});
