import { OpenAI } from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ANTI_BOILERPLATE = `
Do not repeat or rephrase the user's prompt in your answers.
Start your answer directly, no introductions such as "Certainly", "Sure", or similar.
Do not mention you are an AI or language model.
Focus on giving helpful, clear, and concise information.
Unless the user asks explicitly, give answers with 600-700 words.
Make the answers readable but also speech friendly, as if it was to be read aloud and the audience is the listener.
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
  try {
    const { messages } = JSON.parse(event.body);
    if (!Array.isArray(messages)) throw new Error("No messages");

    // Insert the anti-boilerplate system prompt at the start (after any topic system or before user)
    let contextMsgs = messages.slice();
    // Find the index to insert after first system message, or else just at the start
    let systemIdx = contextMsgs.findIndex(m => m.role === "system");
    if (systemIdx >= 0) {
      contextMsgs.splice(systemIdx + 1, 0, { role: "system", content: ANTI_BOILERPLATE });
    } else {
      contextMsgs.unshift({ role: "system", content: ANTI_BOILERPLATE });
    }

    // 1. Get assistant reply
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: contextMsgs,
      temperature: 0.7,
      max_tokens: 3000,
    });
    const reply = completion.choices[0].message.content;

    // 2. Get suggestions (include the new assistant reply in context)
    const allMessages = [...messages, { role: "assistant", content: reply }];
    const suggestions = await getSuggestions(allMessages);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reply,
        suggestions
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message || "Unknown error" }),
    };
  }
}