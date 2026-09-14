/**
 * Azure Speech neural TTS - sl-SI-PetraNeural. FALLBACK voice.
 *
 * Plain REST (no SDK): one POST with SSML, returns MP3. Boringly reliable,
 * which is exactly what a fallback should be.
 */
import { fetchWithTimeout } from '../util.js';

export const id = 'azure';

export function isConfigured() {
  return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

export function describe() {
  return {
    id,
    configured: isConfigured(),
    voice: process.env.AZURE_TTS_VOICE || 'sl-SI-PetraNeural',
    language: 'sl-SI',
  };
}

/** Escape the five XML entities so a quote in an answer cannot break the SSML. */
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {string} text
 * @param {{timeoutMs?:number, signal?:AbortSignal, speed?:number}} opts
 *   `speed` is a multiplier (1.0 = normal), matching the other two providers,
 *   converted to SSML's percentage `<prosody rate>` below. Azure has no env-var
 *   default of its own (it never read TTS_SPEED, unlike openai/google) - when
 *   `speed` is omitted the SSML carries no <prosody> tag at all, so a fallback
 *   to Azure sounds exactly as it always has.
 * @returns {Promise<{buffer:Buffer, contentType:string, provider:string, voice:string}>}
 */
export async function synthesize(text, { timeoutMs = 6000, signal, voice: voiceOverride, speed } = {}) {
  if (!isConfigured()) throw new Error('azure_tts_not_configured');

  const voice = voiceOverride || process.env.AZURE_TTS_VOICE || 'sl-SI-PetraNeural';
  const region = process.env.AZURE_SPEECH_REGION;

  const escaped = xmlEscape(text);
  // 1.0 -> "+0%", 1.5 -> "+50%", 0.8 -> "-20%".
  const body = Number.isFinite(speed) ? `<prosody rate="${Math.round((speed - 1) * 100)}%">${escaped}</prosody>` : escaped;
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="sl-SI">` +
    `<voice name="${voice}">${body}</voice></speak>`;

  const res = await fetchWithTimeout(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'sedemcek',
      },
      body: ssml,
      signal,
    },
    timeoutMs
  );

  if (!res.ok) throw new Error(`azure_tts_http_${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error('azure_tts_empty');

  return { buffer, contentType: 'audio/mpeg', provider: id, voice };
}
