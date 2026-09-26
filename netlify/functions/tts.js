import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LANGUAGE_VOICE_MAP = {
  'English': 'onyx'
};

const MAX_TTS_CHARS = 3400;

export async function handler(event, context) {
  try {
    const { text, language } = JSON.parse(event.body);

    if (!text || !text.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing text" }),
      };
    }

    const part = text.slice(0, MAX_TTS_CHARS);
    const voice = LANGUAGE_VOICE_MAP[language] || 'onyx';

    const response = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice,
      input: part,
      response_format: "mp3",
      speed: 1
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": "inline;filename=tts.mp3"
      },
      isBase64Encoded: true,
      body: buffer.toString('base64')
    };
  } catch (err) {
    console.error("TTS function error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Unknown error" }),
    };
  }
}