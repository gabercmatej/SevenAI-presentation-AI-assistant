/**
 * Google Cloud Text-to-Speech - Chirp 3 HD, sl-SI. PRIMARY voice.
 *
 * Plain REST with an API key on purpose: a service-account JSON file is one
 * more thing to lose on the presentation laptop. Create an API key in Google
 * Cloud, enable "Cloud Text-to-Speech API", restrict the key to that API.
 */
import { fetchWithTimeout } from '../util.js';
import { SPEED } from './openai.js';

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';

export const id = 'google';

export function isConfigured() {
  return Boolean(process.env.GOOGLE_TTS_API_KEY);
}

export function describe() {
  return {
    id,
    configured: isConfigured(),
    voice: process.env.GOOGLE_TTS_VOICE || 'sl-SI-Chirp3-HD-Aoede',
    language: 'sl-SI',
  };
}

/**
 * @param {string} text
 * @param {{timeoutMs?:number, signal?:AbortSignal, speed?:number}} opts
 *   `speed` overrides the module-level SPEED (env TTS_SPEED, imported from
 *   openai.js) for this one request - see server/tts/openai.js for the full
 *   explanation. Omit it to keep today's behaviour unchanged.
 * @returns {Promise<{buffer:Buffer, contentType:string, provider:string, voice:string}>}
 */
export async function synthesize(text, { timeoutMs = 6000, signal, voice: voiceOverride, speed } = {}) {
  if (!isConfigured()) throw new Error('google_tts_not_configured');

  const voice = voiceOverride || process.env.GOOGLE_TTS_VOICE || 'sl-SI-Chirp3-HD-Aoede';
  const rate = Number.isFinite(speed) ? speed : SPEED;

  const res = await fetchWithTimeout(
    `${ENDPOINT}?key=${encodeURIComponent(process.env.GOOGLE_TTS_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        // Chirp 3 HD voice names carry their locale (sl-SI-Chirp3-HD-Aoede),
        // so /voice-test can audition a voice in any language without a code change.
        voice: { languageCode: (voice.match(/^[a-z]{2}-[A-Z]{2}/) || ['sl-SI'])[0], name: voice },
        // Chirp 3 HD ignores pitch entirely and, in testing, speakingRate too -
        // but a Standard, WaveNet or Neural2 voice honours it, so the pace
        // matches the other providers if the voice is ever changed.
        audioConfig: { audioEncoding: 'MP3', speakingRate: rate },
      }),
      signal,
    },
    timeoutMs
  );

  if (!res.ok) {
    // Never echo the body verbatim into logs: it can contain the request URL.
    throw new Error(`google_tts_http_${res.status}`);
  }

  const json = await res.json();
  if (!json.audioContent) throw new Error('google_tts_empty');

  return {
    buffer: Buffer.from(json.audioContent, 'base64'),
    contentType: 'audio/mpeg',
    provider: id,
    voice,
  };
}
