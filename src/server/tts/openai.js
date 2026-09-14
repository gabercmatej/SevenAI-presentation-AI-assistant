/**
 * OpenAI TTS (gpt-4o-mini-tts). THIRD in the chain.
 *
 * Slovenian is supported but the accent is variable - use the /voice-test page
 * to judge it on the room's speakers before relying on it.
 */
import { fetchWithTimeout } from '../util.js';

export const id = 'openai';

/**
 * Speaking rate. 1.0 is the provider's own pace, which reads as slow in a
 * meeting; 1.5 is a presenter talking, not a narrator reading.
 * Measured: the same sentence runs 6.0 s at 1.0 and 4.2 s at 1.5.
 */
export const SPEED = Number(process.env.TTS_SPEED || 1.5);

export function isConfigured() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function describe() {
  return {
    id,
    configured: isConfigured(),
    voice: process.env.OPENAI_TTS_VOICE || 'alloy',
    language: 'sl',
  };
}

/**
 * @param {string} text
 * @param {{timeoutMs?:number, signal?:AbortSignal, speed?:number}} opts
 *   `speed` overrides the module-level SPEED (env TTS_SPEED) for this one
 *   request - a presentation's `settings.speakingSpeed` (server/presentations.js)
 *   arrives here this way. Omit it (or pass a non-finite value) to keep
 *   today's behaviour: the env default, unchanged.
 * @returns {Promise<{buffer:Buffer, contentType:string, provider:string, voice:string}>}
 */
export async function synthesize(text, { timeoutMs = 6000, signal, voice: voiceOverride, speed } = {}) {
  if (!isConfigured()) throw new Error('openai_tts_not_configured');

  const voice = voiceOverride || process.env.OPENAI_TTS_VOICE || 'alloy';
  const rate = Number.isFinite(speed) ? speed : SPEED;

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/audio/speech',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice,
        input: text,
        response_format: 'mp3',
        // Pace. Done here rather than by speeding the audio up in the browser:
        // the provider time-stretches without moving the pitch, while
        // playbackRate on a Web Audio buffer resamples and would raise his
        // voice by seven semitones.
        speed: rate,
        // Steer the delivery: this is a business presentation, not an audiobook.
        instructions:
          'Speak in natural Slovenian. Calm, confident, warm, professional. ' +
          'Brisk, energetic pace, like a senior consultant presenting to a client.',
      }),
      signal,
    },
    timeoutMs
  );

  if (!res.ok) throw new Error(`openai_tts_http_${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('openai_tts_empty');

  return { buffer, contentType: 'audio/mpeg', provider: id, voice };
}

/**
 * Streaming variant of the same request: `response_format: 'pcm'` instead of
 * 'mp3'. OpenAI writes raw 24 kHz / 16-bit / mono / little-endian samples to
 * the response body as they are generated - no container to wait for, no
 * decode step, which is what lets the browser start playing before the
 * sentence is even finished being synthesized.
 *
 * Measured against the same short opener ("Seveda."): first PCM byte at
 * ~590 ms vs ~1450 ms for the complete mp3 file - see scripts/measure-latency.js.
 * The caller owns the returned stream and must read it to completion or
 * cancel it; nothing here buffers the body.
 *
 * @param {string} text
 * @param {{timeoutMs?:number, signal?:AbortSignal, speed?:number}} opts
 *   `speed`: same override rule as synthesize() above.
 * @returns {Promise<{stream:ReadableStream, contentType:string, provider:string, voice:string}>}
 */
export async function synthesizeStream(text, { timeoutMs = 6000, signal, voice: voiceOverride, speed } = {}) {
  if (!isConfigured()) throw new Error('openai_tts_not_configured');

  const voice = voiceOverride || process.env.OPENAI_TTS_VOICE || 'alloy';
  const rate = Number.isFinite(speed) ? speed : SPEED;

  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/audio/speech',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
        voice,
        input: text,
        response_format: 'pcm',
        speed: rate,
        instructions:
          'Speak in natural Slovenian. Calm, confident, warm, professional. ' +
          'Brisk, energetic pace, like a senior consultant presenting to a client.',
      }),
      signal,
    },
    timeoutMs
  );

  if (!res.ok) throw new Error(`openai_tts_http_${res.status}`);
  if (!res.body) throw new Error('openai_tts_no_stream');

  return {
    stream: res.body,
    // rate/encoding/bits/channels spelled out so the browser never has to
    // guess the PCM layout - see public/js/tts-player.js's PcmStream.
    contentType: 'audio/pcm;rate=24000;encoding=signed-integer;bits=16;channels=1',
    provider: id,
    voice,
  };
}
