// netlify/edge-functions/image-gen.js
// Image generation (OpenAI GPT Image or Gemini Image).
// Edge function: starts the response immediately and sends "\n" every 5 seconds
// while waiting, so long generations (10-60 s) do not time out.
// The LAST line of the response is JSON: { b64, mime } or { error }.
// Images are NOT saved anywhere on the server.
const env = (name) => Netlify.env.get(name);
// Shape -> size (OpenAI) / aspect ratio (Gemini)
const OPENAI_SIZES = { square: "1024x1024", portrait: "1024x1536", landscape: "1536x1024" };
const GEMINI_RATIOS = { square: "1:1", portrait: "2:3", landscape: "3:2" };
const QUALITIES = ["low", "medium", "high"];
// ---- Check the Supabase login token. Returns the user, or null if not allowed ----
async function verifyUser(req) {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "").trim();
    if (!token) return null;
    const resp = await fetch(env("SUPABASE_URL") + "/auth/v1/user", {
      headers: { apikey: env("SUPABASE_ANON_KEY"), Authorization: "Bearer " + token }
    });
    if (!resp.ok) return null;
    const u = await resp.json();
    const allowed = (env("ALLOWED_EMAILS") || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allowed.length && !allowed.includes((u.email || "").toLowerCase())) return null;
    return u;
  } catch (e) {
    return null;
  }
}
// ---- OpenAI GPT Image ----
async function openaiImage(prompt, model, quality, shape) {
  const key = env("OPENAI_API_KEY");
  if (!key) throw new Error("Missing OPENAI_API_KEY");
  const resp = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + key,
    },
    body: JSON.stringify({
      model,
      prompt,
      n: 1,
      size: OPENAI_SIZES[shape] || "1024x1024",
      quality: QUALITIES.includes(quality) ? quality : "low",
      output_format: "jpeg",     // smaller than png = faster download
      output_compression: 85
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("OpenAI: " + (data.error?.message || resp.statusText));
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no image");
  return { b64, mime: "image/jpeg" };
}
// ---- Gemini Image ----
async function geminiImage(prompt, model, shape) {
  const key = env("Gemini_API_Key");
  if (!key) throw new Error("Missing Gemini_API_Key");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: GEMINI_RATIOS[shape] || "1:1" }
      }
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error("Gemini: " + (data.error?.message || resp.statusText));
  const cand = data.candidates?.[0];
  const parts = cand?.content?.parts || [];
  // Use the last real image (skip "thinking" images if the model sends any)
  const imgs = parts.filter(p => (p.inlineData?.data || p.inline_data?.data) && !p.thought);
  const img = imgs[imgs.length - 1];
  if (!img) {
    const txt = parts.map(p => p.text || "").join(" ").trim();
    const reason = cand?.finishReason || data.promptFeedback?.blockReason || "";
    throw new Error("Gemini returned no image" + (txt ? ": " + txt : (reason ? " (" + reason + ")" : "")));
  }
  const d = img.inlineData || img.inline_data;
  return { b64: d.data, mime: d.mimeType || d.mime_type || "image/png" };
}
// ---- Handler ----
export default async (req, context) => {
  const authUser = await verifyUser(req);
  if (!authUser) {
    return new Response(JSON.stringify({ error: "Not logged in (or not allowed)" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }
  let prompt, model, quality, shape;
  try {
    const body = await req.json();
    prompt = String(body.prompt || "").trim();
    model = String(body.model || "gpt-image-1-mini").trim();
    quality = body.quality || "low";
    shape = body.shape || "square";
    if (!prompt) throw new Error("Missing prompt");
    if (!/^(gpt-image|dall-e|gemini)/i.test(model)) throw new Error("Unknown image model: " + model);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Bad request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Keep-alive: send a newline every 5 seconds while the image is generated
      controller.enqueue(encoder.encode("\n"));
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode("\n")); } catch (e) {}
      }, 5000);
      try {
        const result = /^gemini/i.test(model)
          ? await geminiImage(prompt, model, shape)
          : await openaiImage(prompt, model, quality, shape);
        clearInterval(keepAlive);
        controller.enqueue(encoder.encode(JSON.stringify(result) + "\n"));
      } catch (err) {
        clearInterval(keepAlive);
        console.error("image-gen ERROR:", err.stack || err);
        controller.enqueue(encoder.encode(JSON.stringify({ error: err.message || "Unknown error" }) + "\n"));
      } finally {
        controller.close();
      }
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" }
  });
};
// The URL this edge function answers on (no netlify.toml change needed)
export const config = { path: "/api/image" };