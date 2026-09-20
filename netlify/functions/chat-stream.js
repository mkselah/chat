import { OpenAI } from "openai";
import fetch from "node-fetch";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GEMINI_API_KEY = process.env.Gemini_API_Key;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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
// Invisible marker that separates the visible reply from the trailing JSON metadata
const META_MARKER = "\u0000__META__\u0000";
// ---- Suggestions helper (same logic as chat.js) ----
async function getSuggestions(messages) {
  const suggestionPrompt = [
    ...messages,
    {
      role: "system",
      content: "Given the conversation so far, suggest 3 concise, engaging, natural next user questions to keep the dialog going. Only return a numbered JSON array of 3 questions."
    }
  ];
  const suggestionResp = await openai.chat.completions.create({
    model: "gpt-4.1",
    messages: suggestionPrompt,
    temperature: 0.65,
    max_tokens: 140,
  });
  let suggestions = [];
  try {
    const m = suggestionResp.choices[0].message.content.match(/\[.*?\]/s);
    if (m) suggestions = JSON.parse(m[0]);
  } catch (e) {
    suggestions = [];
  }
  if (!Array.isArray(suggestions) || suggestions.length !== 3) {
    suggestions = suggestionResp.choices[0].message.content
      .split('\n').map(s => s.replace(/^[\d\-\*\.]+\s*/, '').trim()).filter(Boolean).slice(0,3);
  }
  return suggestions;
}
// ---- Gemini (non-streaming call, same as chat.js) ----
async function geminiChat(messages) {
  const systemMsg = messages.find(m => m.role === "system");
  const systemInstruction = systemMsg
    ? { parts: [{ text: systemMsg.content }] }
    : undefined;
  const geminiMsgs = messages
    .filter(m => m.role !== "system")
    .map(msg => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }]
    }));
  const payload = {
    contents: geminiMsgs,
    ...(systemInstruction && { systemInstruction })
  };
  if (!GEMINI_API_KEY) throw new Error("Missing Gemini_API_Key");
  const modelName = "gemini-3.6-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errJson = await resp.json();
    throw new Error("Gemini API: " + (errJson.error?.message || resp.statusText));
  }
  const data = await resp.json();
  const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n\n");
  if (!reply) throw new Error("Gemini did not return an answer.");
  return { reply };
}
// ---- Claude (non-streaming call, same as chat.js) ----
async function claudeChat(messages, modelId) {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
  const systemMsg = messages.find(m => m.role === "system");
  const systemPrompt = systemMsg ? systemMsg.content : undefined;
  const claudeMsgs = messages
    .filter(m => m.role !== "system")
    .map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content
    }));
  const payload = {
    model: modelId,
    max_tokens: 4096,
    messages: claudeMsgs,
    ...(systemPrompt && { system: systemPrompt })
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const errJson = await resp.json().catch(() => ({}));
    throw new Error("Claude API: " + (errJson.error?.message || resp.statusText));
  }
  const data = await resp.json();
  const reply = data.content?.map(c => c.text).join("\n\n");
  if (!reply) throw new Error("Claude did not return an answer.");
  return { reply };
}
// ---- Streaming handler (new Fetch-API style function) ----
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
  let contextMsgs = messages.slice();
  let systemIdx = contextMsgs.findIndex(m => m.role === "system");
  if (systemIdx >= 0) {
    contextMsgs.splice(systemIdx + 1, 0, { role: "system", content: ANTI_BOILERPLATE });
  } else {
    contextMsgs.unshift({ role: "system", content: ANTI_BOILERPLATE });
  }
  const useModel = model || "gpt-4.1";
  const stream = new ReadableStream({
    async start(controller) {
      let fullReply = "";
      try {
        if (/^gemini/i.test(useModel)) {
          const result = await geminiChat(contextMsgs);
          fullReply = result.reply;
          controller.enqueue(encoder.encode(fullReply));
        } else if (/^claude/i.test(useModel)) {
          const result = await claudeChat(contextMsgs, useModel);
          fullReply = result.reply;
          controller.enqueue(encoder.encode(fullReply));
        } else {
          // OpenAI: true token streaming
          const NEEDS_COMPLETION_TOKENS = /(gpt-5-2025-08-07|o3-mini|gpt-5\.2|o3|gpt-6-astra|gpt-5\.5-2026-04-23)/i;
          const supportsTemperature = !NEEDS_COMPLETION_TOKENS.test(useModel);
          const chatParams = {
            model: useModel,
            messages: contextMsgs,
            stream: true,
          };
          if (supportsTemperature) chatParams.temperature = 0.7;
          if (NEEDS_COMPLETION_TOKENS.test(useModel)) {
            chatParams.max_completion_tokens = 8000;
          } else {
            chatParams.max_tokens = 8000;
          }
          const completionStream = await openai.chat.completions.create(chatParams);
          for await (const chunk of completionStream) {
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              fullReply += delta;
              controller.enqueue(encoder.encode(delta));
            }
          }
        }
        // After the reply is fully sent, append suggestions as hidden metadata
        const allMessages = [...messages, { role: "assistant", content: fullReply }];
        const suggestions = await getSuggestions(allMessages);
        const meta = JSON.stringify({ suggestions });
        controller.enqueue(encoder.encode(META_MARKER + meta));
      } catch (err) {
        console.error("chat-stream ERROR:", err.stack || err);
        const meta = JSON.stringify({ error: err.message || "Unknown error" });
        controller.enqueue(encoder.encode(META_MARKER + meta));
      } finally {
        controller.close();
      }
    }
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
};