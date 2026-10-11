import { OpenAI } from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const LANGUAGE_VOICE_MAP = {
  'English': 'onyx'
};

const MAX_TTS_CHARS = 3400;
// ---- Check the Supabase login token. Returns the user, or null if not allowed ----
async function verifyUser(event) {
  try {
    const h = event.headers || {};
    const auth = h.authorization || h.Authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const resp = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: "Bearer " + token }
    });
    if (!resp.ok) return null;
    const u = await resp.json();
    const allowed = (process.env.ALLOWED_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes((u.email || "").toLowerCase())) return null;
    return u;
  } catch (e) {
    return null;
  }
}

export async function handler(event, context) {
  try {
    const authUser = await verifyUser(event);
    if (!authUser) {
      return { statusCode: 401, body: JSON.stringify({ error: "Not logged in (or not allowed)" }) };
    }
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