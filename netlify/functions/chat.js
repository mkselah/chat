import { OpenAI } from "openai";

import { OpenAI } from "openai";
import fetch from "node-fetch";  // add if not present (node >18: use global fetch)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Helper for Gemini
async function fetchGemini({messages, model, apiKey}) {
  // Format Google Gemini API, see https://ai.google.dev/tutorials/node_quickstart
  // Compose prompt
  const systemMsgs = messages.filter(m => m.role === "system").map(m => m.content).join("\n");
  const contentMsgs = messages.filter(m => m.role === "user" || m.role === "assistant");
  const textParts = [];
  if(systemMsgs) textParts.push(systemMsgs);
  for(const m of contentMsgs) {
    if(m.role === "user") textParts.push(`User: ${m.content}`);
    if(m.role === "assistant") textParts.push(`Assistant: ${m.content}`);
  }
  const prompt = textParts.join("\n");

  // Gemini expects [{role: "user", parts:[{text:...}]}...] format
  let geminiMessages = messages.map(msg=>({
    role: msg.role==="assistant"?"model":"user",
    parts: [{text: msg.content}]
  }));

  // POST to Google API
  const response = await fetch(`https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body: JSON.stringify({contents: geminiMessages, generationConfig:{maxOutputTokens: 2048, temperature: 0.7}})
  });
  if(!response.ok) {
    const errData = await response.json().catch(()=>({}));
    throw new Error("Gemini Error: " + (errData.error?.message || response.statusText));
  }
  const data = await response.json();
  const reply = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  return {reply, usage:{}, timing:{}};
}

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

// Helper: After assistant response, ask for 3 concise next user questions to keep the chat going
async function getSuggestions(messages) {
  // Work in user/assistant context; give prompt in English for now
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
    // Try to extract JSON array
    const m = suggestionResp.choices[0].message.content.match(/\[.*?\]/s);
    if (m) suggestions = JSON.parse(m[0]);
  } catch (e) {
    suggestions = [];
  }
  if (!Array.isArray(suggestions) || suggestions.length !== 3) {
    // fallback: split by lines if not JSON
    suggestions = suggestionResp.choices[0].message.content
      .split('\n').map(s => s.replace(/^[\d\-\*\.]+\s*/, '').trim()).filter(Boolean).slice(0,3);
  }
  return suggestions;
}

export async function handler(event) {
  const startTime = Date.now();
  try {
    const { messages, model, geminiApiKey } = JSON.parse(event.body);
    if (!Array.isArray(messages)) throw new Error("No messages");
    if (!model) throw new Error("No LLM model specified!");

    // choose between OpenAI and Gemini
    let reply, suggestions, usage={};
    if (model.startsWith("gemini")) {
      // --- Gemini ---
      if(!geminiApiKey) throw new Error("Missing Gemini API key (client must send)");
      const r = await fetchGemini({messages,model,apiKey:geminiApiKey});
      reply = r.reply;
      usage = r.usage;
      // Suggestions: fallback (optionally, you might add Gemini suggestion generation too)
      suggestions = ["", "", ""];
    } else {
      // --- OpenAI as before ---
      // ...EXISTING OpenAI HANDLING CODE...
      // 1. Insert anti-boilerplate, call OpenAI completion, usage, suggestions etc
      // copy/paste from your current OpenAI part...
      let contextMsgs = messages.slice();
      let systemIdx = contextMsgs.findIndex(m => m.role === "system");
      if (systemIdx >= 0) {
        contextMsgs.splice(systemIdx + 1, 0, { role: "system", content: ANTI_BOILERPLATE });
      } else {
        contextMsgs.unshift({ role: "system", content: ANTI_BOILERPLATE });
      }
      const useModel = model || "gpt-4.1";
      const supportsTemperature = !/(gpt-5-2025-08-07|o3-mini|gpt-5.2|o3)/i.test(useModel);
      const chatParams = {
        model: useModel,
        messages: contextMsgs,
      };
      if (supportsTemperature) {
        chatParams.temperature = 0.7;
      }
      if (/(gpt-5-2025-08-07|o3-mini|gpt-5.2|o3)/i.test(useModel)) {
        chatParams.max_completion_tokens = 8000;
      } else {
        chatParams.max_tokens = 8000;
      }
      const completion = await openai.chat.completions.create(chatParams);
      reply = completion.choices[0].message.content;
      usage = completion.usage || {};
      const suggStart = Date.now();
      const allMessages = [...messages, { role: "assistant", content: reply }];
      suggestions = await getSuggestions(allMessages);
    }

    // Compose reply as before
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        suggestions,
        usage
      }),
    };
  } catch (err) {
    // ...as before...
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Unknown error", stack: err.stack }),
    };
  }
}