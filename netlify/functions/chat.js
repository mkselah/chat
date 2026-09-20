import { OpenAI } from "openai";
import fetch from "node-fetch"; // <-- Needed for Gemini fetch
// ^^^ If Netlify doesn't natively have fetch in Node, do: npm i node-fetch
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const GEMINI_API_KEY = process.env.Gemini_API_Key; // Your Gemini Netlify env var
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY; // Your Claude Netlify env var

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

// Helper: Suggestions as before (still uses OpenAI for suggestions for now)
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

// --- GEMINI LLM CALLER ---
async function geminiChat(messages, modelName) {
  // Extract system prompt if present
  const systemMsg = messages.find(m => m.role === "system");
  const systemInstruction = systemMsg 
    ? { parts: [{ text: systemMsg.content }] } 
    : undefined;
  // Filter out system messages from contents array
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
  // Use whichever Gemini model was selected in the dropdown; default to gemini-3.8-flash
  const useModelName = modelName || "gemini-3.8-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${useModelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
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
// --- CLAUDE (ANTHROPIC) LLM CALLER ---
async function claudeChat(messages, modelId) {
  if (!ANTHROPIC_API_KEY) throw new Error("Missing ANTHROPIC_API_KEY");
  // Anthropic wants system prompt separate from the messages array
  const systemMsg = messages.find(m => m.role === "system");
  const systemPrompt = systemMsg ? systemMsg.content : undefined;
  // Anthropic only accepts role "user" or "assistant"
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
export async function handler(event) {
  const startTime = Date.now();
  try {
    const { messages, model } = JSON.parse(event.body);
    if (!Array.isArray(messages)) throw new Error("No messages");

    let contextMsgs = messages.slice();
    let systemIdx = contextMsgs.findIndex(m => m.role === "system");
    if (systemIdx >= 0) {
      contextMsgs.splice(systemIdx + 1, 0, { role: "system", content: ANTI_BOILERPLATE });
    } else {
      contextMsgs.unshift({ role: "system", content: ANTI_BOILERPLATE });
    }

    // Which model?
    const useModel = model || "gemini-3.8-flash";
    let reply = "", usage = {}, timing = {};
    if (/^gemini/i.test(useModel)) {
      // Use Gemini
      const llmStart = Date.now();
      const geminiResult = await geminiChat(contextMsgs, useModel);
      timing.llmDuration = Date.now() - llmStart;
      reply = geminiResult.reply;
      // Usage estimation: Not provided by Gemini, so leave usage empty
    } else if (/^claude/i.test(useModel)) {
      // Use Claude (Anthropic)
      const llmStart = Date.now();
      const claudeResult = await claudeChat(contextMsgs, useModel);
      timing.llmDuration = Date.now() - llmStart;
      reply = claudeResult.reply;
      // Usage estimation: not parsed here, leave usage empty
    } else {
      // Use OpenAI as before
      const llmStart = Date.now();

      const NEEDS_COMPLETION_TOKENS = /(gpt-5-2025-08-07|o3-mini|gpt-5\.2|o3|gpt-6-astra|gpt-5\.5-2026-04-23)/i;
      const supportsTemperature = !NEEDS_COMPLETION_TOKENS.test(useModel);
      const chatParams = { model: useModel, messages: contextMsgs };
      if (supportsTemperature) chatParams.temperature = 0.7;
      if (NEEDS_COMPLETION_TOKENS.test(useModel)) {
        chatParams.max_completion_tokens = 8000;
      } else {
        chatParams.max_tokens = 8000;
      }
      const completion = await openai.chat.completions.create(chatParams);
      timing.llmDuration = Date.now() - llmStart;
      reply = completion.choices[0].message.content;
      usage = completion.usage || {};      
    }

    // 2. Get suggestions (still use OpenAI for consistency, or can tweak)
    const suggStart = Date.now();
    const allMessages = [...messages, { role: "assistant", content: reply }];
    const suggestions = await getSuggestions(allMessages);
    timing.suggDuration = Date.now() - suggStart;
    timing.totalDuration = Date.now() - startTime;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        suggestions,
        usage,
        timing,
      }),
    };
  } catch (err) {
    console.error("chat.js ERROR:", err.stack || err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Unknown error", stack: err.stack }),
    };
  }
}