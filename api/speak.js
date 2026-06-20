// api/speak.js
// Thais -- Text-to-Speech via ElevenLabs
// Replaces unreliable browser speechSynthesis with Thais's actual custom voice.
// API key stays server-side only -- never exposed to the browser.

const ELEVENLABS_API_KEY = process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
const THAIS_VOICE_ID = process.env.THAIS_VOICE_ID || '5XrmZSSkdqGwCqYf1yIQ';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!ELEVENLABS_API_KEY) {
    return res.status(500).json({ error: 'Voice not configured' });
  }

  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Text is required' });
  }

  // Strip markdown formatting so it doesn't get read aloud literally
  const clean = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/#{1,6}\s/g, '')
    .trim();

  // ElevenLabs has a per-request character limit -- truncate gracefully
  // rather than erroring on long diagnostic responses
  const MAX_CHARS = 4500;
  const textToSpeak = clean.length > MAX_CHARS ? clean.slice(0, MAX_CHARS) + '...' : clean;

  try {
    const response = await fetch(
      'https://api.elevenlabs.io/v1/text-to-speech/' + THAIS_VOICE_ID,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          text: textToSpeak,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error('[speak] ElevenLabs error:', errText);
      return res.status(502).json({ error: 'Voice generation failed' });
    }

    const audioBuffer = await response.arrayBuffer();

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    return res.status(200).send(Buffer.from(audioBuffer));

  } catch (error) {
    console.error('[speak] error:', error.message);
    return res.status(500).json({ error: 'Voice generation failed' });
  }
}
