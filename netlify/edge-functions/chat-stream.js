// netlify/edge-functions/chat-stream.js
// Edge Function version of chat-stream: no 30-second limit while streaming.
// Same output format as netlify/functions/chat-stream.js (reply text + META_MARKER + JSON lines)
const ANTI_BOILERPLATE = `
Do not repeat or rephrase the user's prompt in your answers.
Start your answer directly, no introductions such as "Certainly", "Sure", or similar.
Do not mention you are an AI or language model.
Focus on giving helpful, clear, and concise information.
Unless the user asks explicitly, give answers with 600-700 words.
Do not include any boilerplate text or disclaimers.
Do not include any system prompts or instructions in your responses.
Do not include any information about your capabilities, limitations, or how you work.
Do not include any information about the OpenAI API or how it is used.
`;
const META_MARKER = "\u0000__META__\u0000";
// Environment variables (same names as in your Netlify settings)
const env = (name) => Netlify.env.get(name);
// ---- Read an SSE response line by line ----
async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const line of parts) yield line;
  }
  if (buffer) yield buffer;
}
// ---- Parse one "data: {...}" SSE line, returns null if not usable ----
function sseData(line) {
  const t = line.trim();
  if (!t.startsWith("data:")) return null;
  const s = t.slice(5).trim();
  if (!s || s === "[DONE]") return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}
async function apiError(prefix, resp) {
  const errJson = await resp.json().catch(() => ({}));
  return new Error(prefix + (errJson.error?.message || resp.statusText));
}
// ---- Suggestions (OpenAI, non-streaming) ----
async function getSuggestions(messages) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env("OPENAI_API_KEY"),
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        ...messages,
        {
          role: "system",
          content: "Given the conversation so far, suggest 3 concise, engaging, natural next user questions to keep the dialog going. Only return a numbered JSON array of 3 questions."
        }
      ],
      temperature: 0.65,
      max_tokens: 140,
    }),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content || "";
  let suggestions = [];
  try {
    const m = content.match(/\[.*?\]/s);
    if (m) suggestions = JSON.parse(m[0]);
  } catch (e) {
    suggestions = [];
  }
  if (!Array.isArray(suggestions) || suggestions.length !== 3) {
    suggestions = content
      .split("\n").map(s => s.replace(/^[\d\-\*\.]+\s*/, "").trim()).filter(Boolean).slice(0, 3);
  }
  return suggestions;
}
// ---- Gemini streaming ----
async function* geminiStreamChat(messages, modelName, info) {
  const key = env("Gemini_API_Key");
  if (!key) throw new Error("Missing Gemini_API_Key");
  const systemMsg = messages.find(m => m.role === "system");
  const payload = {
    contents: messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    ...(systemMsg && { systemInstruction: { parts: [{ text: systemMsg.content }] } })
  };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok || !resp.body) throw await apiError("Gemini API: ", resp);
  for await (const line of sseLines(resp)) {
    const parsed = sseData(line);
    if (!parsed) continue;
    const cand = parsed.candidates?.[0];
    if (cand?.finishReason) info.stopReason = cand.finishReason;
    const text = cand?.content?.parts?.map(p => p.text || "").join("") || "";
    if (text) yield text;
  }
}
// ---- Claude streaming ----
async function* claudeStreamChat(messages, modelId, info) {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  // Join all system messages into one system prompt
  const systemPrompt = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const payload = {
    model: modelId,
    max_tokens: 20000,
    stream: true,
    messages: messages
      .filter(m => m.role !== "system")
      .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    ...(systemPrompt && { system: systemPrompt })
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok || !resp.body) throw await apiError("Claude API: ", resp);
  for await (const line of sseLines(resp)) {
    const parsed = sseData(line);
    if (!parsed) continue;
    if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
      yield parsed.delta.text;
    }
    if (parsed.type === "message_delta" && parsed.delta?.stop_reason) {
      info.stopReason = parsed.delta.stop_reason;
    }
    if (parsed.type === "error") {
      throw new Error("Claude API: " + (parsed.error?.message || "stream error"));
    }
  }
}
// ---- OpenAI streaming ----
async function* openaiStreamChat(messages, modelId, info) {
  const NEEDS_COMPLETION_TOKENS = /(gpt-5-2025-08-07|o3-mini|gpt-5\.2|o3|gpt-6-astra|gpt-5\.5-2026-04-23)/i;
  const newStyle = NEEDS_COMPLETION_TOKENS.test(modelId);
  const params = { model: modelId, messages, stream: true };
  if (newStyle) {
    params.max_completion_tokens = 8000;
  } else {
    params.max_tokens = 8000;
    params.temperature = 0.7;
  }
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + env("OPENAI_API_KEY"),
    },
    body: JSON.stringify(params),
  });
  if (!resp.ok || !resp.body) throw await apiError("OpenAI API: ", resp);
  for await (const line of sseLines(resp)) {
    const parsed = sseData(line);
    if (!parsed) continue;
    const choice = parsed.choices?.[0];
    if (choice?.finish_reason) info.stopReason = choice.finish_reason;
    const delta = choice?.delta?.content;
    if (delta) yield delta;
  }
}
// ---- Handler ----
export default async (req, context) => {
  const encoder = new TextEncoder();
  let messages, model;
  try {
    const body = await req.json();
    messages = body.messages;
    model = body.model;
    if (!Array.isArray(messages)) throw new Error("No messages");
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || "Bad request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
  const contextMsgs = messages.slice();
  const systemIdx = contextMsgs.findIndex(m => m.role === "system");
  if (systemIdx >= 0) {
    contextMsgs.splice(systemIdx + 1, 0, { role: "system", content: ANTI_BOILERPLATE });
  } else {
    contextMsgs.unshift({ role: "system", content: ANTI_BOILERPLATE });
  }
  const useModel = model || "gemini-3.8-flash";
  const stream = new ReadableStream({
    async start(controller) {
      let fullReply = "";
      const info = {};
      let metaStarted = false;
      try {
        let gen;
        if (/^gemini/i.test(useModel)) gen = geminiStreamChat(contextMsgs, useModel, info);
        else if (/^claude/i.test(useModel)) gen = claudeStreamChat(contextMsgs, useModel, info);
        else gen = openaiStreamChat(contextMsgs, useModel, info);
        for await (const delta of gen) {
          fullReply += delta;
          controller.enqueue(encoder.encode(delta));
        }
        controller.enqueue(encoder.encode(
          META_MARKER + JSON.stringify({ replyDone: true, stopReason: info.stopReason || "" }) + "\n"
        ));
        metaStarted = true;
        try {
          const suggestions = await getSuggestions([...messages, { role: "assistant", content: fullReply }]);
          controller.enqueue(encoder.encode(JSON.stringify({ suggestions }) + "\n"));
        } catch (e) {
          console.error("suggestions ERROR:", e.message);
        }
      } catch (err) {
        console.error("edge chat-stream ERROR:", err.stack || err);
        const meta = JSON.stringify({ error: err.message || "Unknown error" }) + "\n";
        controller.enqueue(encoder.encode((metaStarted ? "" : META_MARKER) + meta));
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
export const config = { path: "/api/chat-stream" };