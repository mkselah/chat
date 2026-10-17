import { supabase } from "./setup.js";

const topicDropdown = document.getElementById("topicDropdown");
const addTopicBtn = document.getElementById("addTopicBtn");
const renameTopicBtn = document.getElementById("renameTopicBtn");
const deleteTopicBtn = document.getElementById("deleteTopicBtn");
const instructionsBtn = document.getElementById("instructionsBtn");
const logoutBtn = document.getElementById("logoutBtn");
const pinTopicBtn = document.getElementById("pinTopicBtn");
const menuBtn = document.getElementById("menuBtn");
const topbarMenu = document.getElementById("topbarMenu");

const chatWindow = document.getElementById("chatWindow");
const chatForm = document.getElementById("chatForm");
const userInput = document.getElementById("userInput");

const authSection = document.getElementById("authSection");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const loginBtn = document.getElementById("loginBtn");
const signupBtn = document.getElementById("signupBtn");
const authStatus = document.getElementById("authStatus");
const authForm = document.getElementById("authForm");
const micBtn = document.getElementById("micBtn");

let topics = [];
let messages = [];
let activeTopicIdx = 0;
let user = null;

// New: To hold suggestions for last assistant message (index = message #)
let lastSuggestions = {}; // { messageId: [suggestion1, suggestion2, suggestion3] }
// Markdown parser created ONCE (faster than creating a new one for every streamed chunk)
const md = window.markdownit ? window.markdownit() : null;

// ====== TTS State =======
let ttsState = {
  stopRequested: false,
  audios: [],
  stopBtn: null, // The stop button element
};
// === /End TTS state ===

// ======== Speech Recognition (Mic Input) =========
let rec = null;
let recognizing = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  micBtn.onclick = function() {
    if (!rec) {
      rec = new SpeechRecognition();
      rec.continuous = false;
      rec.lang = 'en-US'; // Optionally set via dropdown in future
      rec.interimResults = false;
      rec.onstart = function() {
        recognizing = true;
        micBtn.textContent = "⏹️";
        micBtn.title = "Stop listening";
        micBtn.style.background = "#e8faee";
      };
      rec.onend = function() {
        recognizing = false;
        micBtn.textContent = "🎤";
        micBtn.title = "Use voice input";
        micBtn.style.background = "";
      };
      rec.onerror = function(e) {
        recognizing = false;
        micBtn.textContent = "🎤";
        micBtn.style.background = "";
        alert("Speech recognition error: " + e.error);
      };
      rec.onresult = function(e) {
        recognizing = false;
        micBtn.textContent = "🎤";
        micBtn.title = "Use voice input";
        micBtn.style.background = "";
        if (e.results && e.results[0] && e.results[0][0]) {
          const transcript = e.results[0][0].transcript;
          // Option: If you want to auto-send, call chatForm.onsubmit()
          userInput.value = userInput.value ? (userInput.value.trim() + " " + transcript) : transcript;
          autoGrow(userInput);
        }
      };
    }
    if (!recognizing) {
      rec.start();
    } else {
      rec.stop();
    }
  };
} else {
  micBtn.disabled = true;
  micBtn.textContent = "🚫";
  micBtn.title = "Speech-to-text not supported in this browser";
}
// ======== END Speech Recognition =========
// ======== Scroll Helpers (manual-scroll friendly) =========
// Only auto-scroll to bottom if the user is already near the bottom.
// This lets users scroll up manually to read without being pulled back down
// while new content streams in.
function isNearBottom(el, threshold = 100) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}
function scrollToBottomIfNear(el) {
  if (isNearBottom(el)) {
    el.scrollTop = el.scrollHeight;
  }
}
// ======== END Scroll Helpers =========
// --- Splits long text into ~1000 char chunks at ".", "!", "?"
// firstLimit: the FIRST chunk can be shorter, so audio starts faster
function splitTextIntoChunks(text, charLimit = 1000, firstLimit = charLimit) {
  if (text.length <= firstLimit) return [text];
  // Sentences ending with . ! ? plus any last part without punctuation (nothing is lost)
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = "";
  for (const sent of sentences) {
    const limit = chunks.length === 0 ? firstLimit : charLimit;
    if (current && (current + sent).length > limit) {
      chunks.push(current);
      current = sent.trim();
    } else {
      current += sent;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
// =======================
// AUTH HEADERS HELPER (sends Supabase login token to our server functions)
// =======================
async function authHeaders() {
  const { data: { session } } = await supabase.auth.getSession(); // refreshes token if expired
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + (session ? session.access_token : "")
  };
}
// =======================
// STREAMING CHAT HELPER
// =======================
const META_MARKER = "\u0000__META__\u0000";
async function streamChat(contextMessages, model, { onChunk, onDone, onError }) {
  let reply = "";
  let metaBuffer = "";
  let sawMeta = false;
  try {
    const resp = await fetch("/api/chat-stream", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ messages: contextMessages, model }),
    });
    if (!resp.ok || !resp.body) {
      const errJson = await resp.json().catch(() => ({}));
      throw new Error(errJson.error || "Request failed");
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value, { stream: true });
      if (!sawMeta) {
        const idx = chunkText.indexOf(META_MARKER);
        if (idx === -1) {
          reply += chunkText;
          onChunk(reply);
        } else {
          reply += chunkText.slice(0, idx);
          onChunk(reply);
          metaBuffer += chunkText.slice(idx + META_MARKER.length);
          sawMeta = true;
        }
      } else {
        metaBuffer += chunkText;
      }
    }
    let meta = {};
    for (const line of metaBuffer.split("\n")) {
      if (!line.trim()) continue;
      try { Object.assign(meta, JSON.parse(line)); } catch (e) {}
    }
    meta.truncated = !meta.replyDone || ["max_tokens", "MAX_TOKENS", "length"].includes(meta.stopReason);
    if (meta.error && !reply) {
      onError(meta.error);
    } else {
      onDone(reply, meta);
    }
  } catch (err) {
    if (reply) {
      onDone(reply, { truncated: true });
    } else {
      onError(err.message || "Unknown error");
    }
  }
}

const CONTINUE_PROMPT = "Your previous answer was cut off. Continue exactly where it stopped. Do not repeat anything and do not add any introduction.";
async function streamChatWithContinue(contextMessages, model, { onChunk, onDone, onError }, maxContinues = 3) {
  let soFar = "";
  let msgs = contextMessages;
  for (let attempt = 0; attempt <= maxContinues; attempt++) {
    let result = null;
    await streamChat(msgs, model, {
      onChunk: (partial) => onChunk(soFar + partial),
      onDone: (reply, meta) => { result = { reply, meta }; },
      onError: (err) => { result = { error: err }; }
    });
    if (result.error) {
      if (soFar) await onDone(soFar + "\n\n*(Response was cut off)*", {});
      else onError(result.error);
      return;
    }
    soFar += result.reply;
    if (!result.meta.truncated) {
      await onDone(soFar, result.meta);
      return;
    }
    if (attempt === maxContinues) {
      await onDone(soFar + "\n\n*(Response was cut off)*", result.meta);
      return;
    }
    msgs = contextMessages.concat([
      { role: "assistant", content: soFar },
      { role: "user", content: CONTINUE_PROMPT }
    ]);
  }
}
// =======================
// AUTH LOGIC
// =======================
function updateAuthUI() {
  if (user) {
    authSection.style.display = "none";
    document.getElementById("app").style.display = "";
    logoutBtn.style.display = "inline";
  } else {
    authSection.style.display = "block";
    authForm.style.display = "";
    logoutBtn.style.display = "none";
    document.getElementById("app").style.display = "none";
  }
}
loginBtn.onclick = async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: authEmail.value,
    password: authPassword.value,
  });
  if (error) {
    authStatus.textContent = error.message;
    return;
  }
  user = data.user;
  loadData();
  updateAuthUI();
};
signupBtn.onclick = async () => {
  const { data, error } = await supabase.auth.signUp({
    email: authEmail.value,
    password: authPassword.value,
  });
  if (error) {
    authStatus.textContent = error.message;
    return;
  }
  user = data.user;
  authStatus.textContent = "Check your email to confirm!";
  updateAuthUI();
};
logoutBtn.onclick = async () => {
  await supabase.auth.signOut();
  user = null;
  topics = [];
  messages = [];
  lastSuggestions = {};
  renderAll();
  updateAuthUI();
};

// =======================
// TOPICS/MESSAGES SYNC
// =======================
async function loadData() {
  if (!user) return;
  let { data: topicRows } = await supabase
    .from('topics')
    .select('*')
    .eq('user_id', user.id)
    .order('name', { ascending: true });
  topics = topicRows || [];
  topics.sort(compareTopics); // pinned first, then most recently used
  if (!topics.length) activeTopicIdx = 0;
  else if (activeTopicIdx >= topics.length) activeTopicIdx = 0;
  if (topics[activeTopicIdx]) {
    document.getElementById("modelDropdown").value = topics[activeTopicIdx].model || "claude-sonnet-5";
  }
  await loadMessages();
  renderAll();
}

async function loadMessages() {
  if (!topics[activeTopicIdx]) { messages = []; return; }
  let { data: messageRows } = await supabase
    .from('messages')
    .select('*')
    .eq('topic_id', topics[activeTopicIdx].id)
    .order('created_at', { ascending: true });
  messages = messageRows || [];
}

async function saveTopic(name) {
  if (!user) return;
  let currentModel = document.getElementById("modelDropdown").value || "claude-sonnet-5";
  let { data, error } = await supabase
    .from('topics')
    .insert({ name, user_id: user.id, model: currentModel })
    .select();
  if (error) return alert(error.message);
  topics.push(data[0]);
  activeTopicIdx = topics.length - 1;
  sortTopics(); // new topic moves to the top (below pinned topics)
  await loadMessages();
  renderAll();
}

async function renameTopic(idx, name) {
  if (!user || !topics[idx]) return;
  let id = topics[idx].id;
  let newModel = document.getElementById("modelDropdown").value || "claude-sonnet-5";
  let { error } = await supabase
    .from('topics')
    .update({ name, model: newModel })
    .eq('id', id);
  if (error) alert(error.message);
  topics[idx].name = name;
  renderAll();
}

async function deleteTopic(idx) {
  if (!user || !topics[idx]) return;
  let topicId = topics[idx].id;
  await supabase.from('messages').delete().eq('topic_id', topicId);
  await supabase.from('topics').delete().eq('id', topicId);
  topics.splice(idx,1);
  if (activeTopicIdx >= topics.length) activeTopicIdx = Math.max(0, topics.length - 1);
  await loadMessages();
  renderAll();
}

// === NEW: Delete a single message ===
async function deleteMessage(msgId) {
  if (!user || !topics[activeTopicIdx]) return;
  if (!confirm("Delete this message?")) return;
  let { error } = await supabase
    .from('messages')
    .delete()
    .eq('id', msgId)
    .eq('topic_id', topics[activeTopicIdx].id);
  if (error) alert(error.message);
  await loadMessages();
  renderAll();
}

// Add message (suggestions are optional, only for assistant messages)
async function addMessage(role, content, suggestions = null) {
  if (!user || !topics[activeTopicIdx]) return;
  let { error } = await supabase
    .from('messages')
    .insert({
      topic_id: topics[activeTopicIdx].id,
      role,
      content,
      ...(suggestions && { suggestions }),
    });
  if (error) alert(error.message);
  // Item 9: remember when this topic was last used
  if (role === "user") {
    const t = topics[activeTopicIdx];
    t.last_used = new Date().toISOString();
    await supabase.from('topics').update({ last_used: t.last_used }).eq('id', t.id);
  }
  await loadMessages();
  renderAll();
}

// =======================
// UI RENDERING
// =======================
function renderTopicsDropdown() {
  topicDropdown.innerHTML = '';
  topics.forEach((t, idx) => {
    const opt = document.createElement('option');
    opt.value = idx;
    opt.textContent = (t.pinned ? "📌 " : "") + t.name;
    topicDropdown.appendChild(opt);
  });
  topicDropdown.value = activeTopicIdx;
  // Pin button: disabled without topics, yellow when the topic is pinned
  pinTopicBtn.disabled = topics.length === 0;
  pinTopicBtn.style.background = topics[activeTopicIdx]?.pinned ? "#ffe9a8" : "";
  // Hide rename/delete if no topics
  renameTopicBtn.disabled = deleteTopicBtn.disabled = topics.length === 0;
  instructionsBtn.disabled = topics.length === 0;
  const sp = topics[activeTopicIdx]?.system_prompt || "";
  instructionsBtn.title = sp ? "Topic instructions: " + sp : "Topic instructions (none set)";
  instructionsBtn.style.background = sp ? "#c9f2d0" : "";
  if(topics[activeTopicIdx]) {
    document.getElementById('currentTopicLabel').textContent = "  (" + topics[activeTopicIdx].name + ")";
  } else {
    document.getElementById('currentTopicLabel').textContent = '';
  }
}
topicDropdown.onchange = async function () {
  activeTopicIdx = parseInt(this.value);
  // Set modelDropdown to this topic's model, default to claude-sonnet-5 if missing
  const topicModel = topics[activeTopicIdx]?.model || "claude-sonnet-5";
  modelDropdown.value = topicModel;
  if (editingMsg) cancelEdit(); // stop editing when switching topic
  await loadMessages();
  renderAll();
};
// Save the model to the current topic whenever the dropdown changes
document.getElementById("modelDropdown").onchange = async function () {
  const t = topics[activeTopicIdx];
  if (!t) return;
  t.model = this.value;
  const { error } = await supabase.from('topics').update({ model: this.value }).eq('id', t.id);
  if (error) alert(error.message);
};
addTopicBtn.onclick = async () => {
  const name = prompt("Topic name?");
  if (name) await saveTopic(name);
};
renameTopicBtn.onclick = async () => {
  if (!topics[activeTopicIdx]) return;
  const name = prompt("Rename topic?", topics[activeTopicIdx].name);
  if (name) await renameTopic(activeTopicIdx, name);
};
deleteTopicBtn.onclick = async () => {
  if (!topics[activeTopicIdx]) return;
  if (confirm("Delete this topic?")) await deleteTopic(activeTopicIdx);
};
// ====== SORT + PIN TOPICS ======
// Pinned topics first, then most recently used first
function compareTopics(a, b) {
  const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
  if (pin !== 0) return pin;
  return (Date.parse(b.last_used) || 0) - (Date.parse(a.last_used) || 0);
}
// Sort topics, but keep the same topic selected
function sortTopics() {
  const activeId = topics[activeTopicIdx]?.id;
  topics.sort(compareTopics);
  const i = topics.findIndex(t => t.id === activeId);
  activeTopicIdx = i >= 0 ? i : 0;
}
pinTopicBtn.onclick = async () => {
  const t = topics[activeTopicIdx];
  if (!t) return;
  const newPinned = !t.pinned;
  const { error } = await supabase.from('topics').update({ pinned: newPinned }).eq('id', t.id);
  if (error) return alert(error.message);
  t.pinned = newPinned;
  sortTopics();
  renderAll();
};
// ====== ☰ MENU (small screens) ======
menuBtn.onclick = () => topbarMenu.classList.toggle("open");
// Close the menu after pressing a button inside it
topbarMenu.addEventListener("click", (e) => {
  if (e.target.tagName === "BUTTON") topbarMenu.classList.remove("open");
});
// ====== ⋯ TOOLS MENU in bottom bar (small screens) ======
const toolsBtn = document.getElementById("toolsBtn");
const formTools = document.getElementById("formTools");
function closeTools() {
  formTools.classList.remove("open");
  toolsBtn.classList.remove("open");
}
toolsBtn.onclick = () => {
  formTools.classList.toggle("open");
  toolsBtn.classList.toggle("open");
};
// Close after 📄 or 📈 (🎤 keeps it open, so you can see and press ⏹️)
document.getElementById("showSheetBtn").addEventListener("click", closeTools);
document.getElementById("dashboardBtn").addEventListener("click", closeTools);
document.getElementById("imageBtn").addEventListener("click", closeTools);
// Close when a message is sent
chatForm.addEventListener("submit", closeTools);
// ====== Show ⋯ only while typing (mobile) ======
// Tapping the text box shows ⋯ (CSS uses the class "typing")
userInput.addEventListener("focus", () => chatForm.classList.add("typing"));
// Leaving the text box hides ⋯ again, unless the tools row is open
// or a button inside the bottom bar was tapped
userInput.addEventListener("blur", () => {
  setTimeout(() => {
    if (formTools.classList.contains("open")) return;
    if (chatForm.contains(document.activeElement)) return;
    chatForm.classList.remove("typing");
  }, 150);
});
// Tapping in the chat area (reading) hides ⋯ and closes the tools row
chatWindow.addEventListener("click", () => {
  if (document.activeElement === userInput) return;
  closeTools();
  chatForm.classList.remove("typing");
});
// ====== END Show ⋯ only while typing ======
// Mobile: after sending, close the keyboard so the text box shrinks to 1 line and the answer is easy to read
chatForm.addEventListener("submit", () => {
  if (window.matchMedia("(max-width: 600px)").matches) userInput.blur();
});
// ====== END SORT + PIN + MENU ======
// ====== PER-TOPIC INSTRUCTIONS (system_prompt) ======
// Multi-line popup instead of prompt()
const instructionsPanel = document.getElementById("instructionsPanel");
const instructionsText = document.getElementById("instructionsText");
const instructionsSaveBtn = document.getElementById("instructionsSaveBtn");
const instructionsCancelBtn = document.getElementById("instructionsCancelBtn");
function closeInstructions() {
  instructionsPanel.style.display = "none";
}
instructionsBtn.onclick = () => {
  const t = topics[activeTopicIdx];
  if (!t) return;
  instructionsText.value = t.system_prompt || "";
  document.getElementById("instructionsTitle").textContent = "Instructions for: " + t.name;
  instructionsPanel.style.display = "flex";
  instructionsText.focus();
};
instructionsCancelBtn.onclick = closeInstructions;
// Click on dark background closes too
instructionsPanel.onclick = (e) => {
  if (e.target === instructionsPanel) closeInstructions();
};
// Escape key closes
instructionsText.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeInstructions();
});
instructionsSaveBtn.onclick = async () => {
  const t = topics[activeTopicIdx];
  if (!t) return closeInstructions();
  const newPrompt = instructionsText.value.trim();
  instructionsSaveBtn.disabled = true;
  instructionsSaveBtn.textContent = "…";
  const { error } = await supabase
    .from('topics')
    .update({ system_prompt: newPrompt })
    .eq('id', t.id);
  instructionsSaveBtn.disabled = false;
  instructionsSaveBtn.textContent = "Save";
  if (error) return alert(error.message);
  t.system_prompt = newPrompt;
  renderTopicsDropdown();
  closeInstructions();
};
// Builds the messages sent to the LLM: topic instructions (if any) + chat history
function buildContextMessages() {
  const t = topics[activeTopicIdx];
  const history = messages.map(m => ({ role: m.role, content: m.content }));
  if (t && t.system_prompt && t.system_prompt.trim()) {
    return [{ role: "system", content: t.system_prompt.trim() }, ...history];
  }
  return history;
}
// ====== END PER-TOPIC INSTRUCTIONS ======

// ====== COPY BUTTON FEATURE ======
// Helper: Copy text to clipboard (fallback for older browsers)
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    // Clipboard API
    navigator.clipboard.writeText(text);
  } else {
    // Legacy fallback
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}
// ====== GOOGLE CALENDAR BUTTON FEATURE ======
// Opens Google Calendar with a pre-filled event (no API key needed).
// You check the details in Google Calendar and click "Save".
const GCAL_MAX_DETAILS = 1500; // keep the URL short enough for Google

function stripInlineMarkdown(s) {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")              // images -> alt text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")         // [text](url) -> text (url)
    .replace(/`([^`]+)`/g, "$1")                            // `code`
    .replace(/\*\*(.+?)\*\*/g, "$1")                        // **bold**
    .replace(/__(.+?)__/g, "$1")                            // __bold__
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2") // *italic*
    .replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, "$1$2")   // _italic_
    .replace(/~~(.+?)~~/g, "$1")                            // ~~strike~~
    .replace(/\*\*/g, "");                                  // any leftover **
}
function markdownToPlainText(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  // Heading helper: blank line before it (if needed), heading in CAPITALS
  const pushHeading = (h) => {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    out.push(h);
  };
  for (let line of lines) {
    // Skip code fences ```
    if (/^\s*```/.test(line)) continue;
    // Horizontal rule --- / *** / ___
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("──────────"); continue; }
    // Table separator row |---|---|
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    // # Heading
    let m = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (m) { pushHeading(stripInlineMarkdown(m[1]).trim().toUpperCase()); continue; }
    // Whole line bold: **Sat – Persistence Challenge**  or  **After 15 minutes, ask:**
    m = line.match(/^\s*\*\*([^*]+)\*\*\s*(:?)\s*$/);
    if (m) { pushHeading((m[1].trim() + m[2]).toUpperCase()); continue; }
    // Bold label at start: **Goal:** text   or   **Goal**: text
    m = line.match(/^(\s*)\*\*([^*]+?)\*\*\s*(:?)\s*(.+)$/);
    if (m && (m[2].trim().endsWith(":") || m[3] === ":")) {
      if (out.length && out[out.length - 1].trim() !== "" && !m[1]) out.push("");
      out.push(m[1] + (m[2].trim() + m[3]).toUpperCase() + " " + stripInlineMarkdown(m[4]));
      continue;
    }
    // > quote
    line = line.replace(/^(\s*)>\s?/, "$1");
    // Bullets - * +  ->  •
    line = line.replace(/^(\s*)[-*+]\s+/, "$1• ");
    // Table row | a | b |  ->  a  –  b
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()).join("  –  ");
    }
    out.push(stripInlineMarkdown(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ====== TTS: clean markdown so it sounds natural when read aloud ======
function textForSpeech(mdText) {
  const lines = String(mdText || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inCode = false;
  for (let line of lines) {
    // Skip code blocks completely (code sounds strange when read aloud)
    if (/^\s*```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    // Skip horizontal rules --- *** ___
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue;
    // Skip table separator rows |---|---|
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    line = line.replace(/^\s*#{1,6}\s+/, "");   // # Heading
    line = line.replace(/^\s*>\s?/, "");        // > quote
    line = line.replace(/^\s*[-*+]\s+/, "");    // - bullet
    // Table row | a | b |  ->  a, b
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()).filter(Boolean).join(", ");
    }
    line = line.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");  // images -> alt text
    line = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");   // links -> text only (no URL read aloud)
    line = stripInlineMarkdown(line);                       // **bold**, *italic*, `code` ...
    line = line.replace(/https?:\/\/\S+/g, "").trim();     // bare URLs
    if (!line) continue;
    // Short pause after headings, bullets and table rows
    if (!/[.!?:;,]$/.test(line)) line += ".";
    out.push(line);
  }
  return out.join("\n");
}
// ====== END TTS clean ======

function addToGoogleCalendar(text) {
  const title = topics[activeTopicIdx] ? topics[activeTopicIdx].name : "Chat note";
  // All-day event today (date/time can be changed in Google Calendar before saving)
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  const fmt = x => x.getFullYear() + String(x.getMonth() + 1).padStart(2, "0") + String(x.getDate()).padStart(2, "0");
  const plain = markdownToPlainText(text);
  let details = plain;
  if (details.length > GCAL_MAX_DETAILS) {
    details = details.slice(0, GCAL_MAX_DETAILS) + "\n\n…(text shortened – full text is copied to your clipboard, paste it here)";
    copyToClipboard(plain);
  }
  const url = "https://calendar.google.com/calendar/render?action=TEMPLATE"
    + "&text=" + encodeURIComponent(title)
    + "&dates=" + fmt(d) + "/" + fmt(next)
    + "&details=" + encodeURIComponent(details);
  const win = window.open(url, "_blank");
  if (!win) window.location.href = url; // fallback if popup was blocked
}
// ===== END GOOGLE CALENDAR BUTTON FEATURE =======

// === MODIFIED: Chat area w/ delete message support and suggestion buttons and LISTEN BUTTON and COPY BUTTON ===
function renderChat() {
  chatWindow.innerHTML = '';
  if (!topics[activeTopicIdx]) return;
  // For suggestions: find last assistant message and see if we have suggestions for it
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; --i) {
    if (messages[i].role === "assistant") { lastAssistantIdx = i; break; }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, function(c) {
      return ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;",
        '"': "&quot;", "'": "&#039;"
      })[c];
    });
  }

  messages.forEach((msg, idx) => {
    // Create bubble row (no longer flex)
    const div = document.createElement('div');
    div.className = msg.role;

    // --- Message content as before ---
    if (msg.role === "assistant") {
      // Use Markdown rendering for assistant
      if (md) {
        div.innerHTML = md.render(msg.content);
      } else {
        div.innerHTML = msg.content.replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
      }
    } else {
      // Render user message, preserving formatting (line breaks, spaces)
      // Two methods possible: use <pre> or convert to <br> (use <pre> here for UX)
      div.innerHTML = "<pre style='margin:0;background:none;border:none;font-family:inherit;font-size:inherit;padding:0;box-shadow:none;white-space:pre-wrap;word-break:break-word;'>" +
        escapeHtml(msg.content) + "</pre>";
    }

    chatWindow.appendChild(div);

    // ====== Action row for assistant: Listen/Download/Trash/Copy in new row below bubble ======
    if (msg.role === "assistant") {
      const actionRow = document.createElement('div');
      actionRow.className = "action-row";

      // Listen Button
      const listenBtn = document.createElement('button');
      listenBtn.textContent = "🔊";
      listenBtn.title = "Listen to this message (TTS)";
      listenBtn.className = "listen-btn";
      listenBtn.onclick = async () => {
        listenBtn.disabled = true;
        listenBtn.textContent = "…";
        try {
          // Clean markdown before reading aloud (fallback: raw text if nothing is left)
          const speech = textForSpeech(msg.content) || msg.content;
          await playTTSwithStop(speech, "English", actionRow, listenBtn);
        } catch (e) {
          alert("Could not play audio: " + (e.message||e));
        }
        listenBtn.textContent = "🔊";
        listenBtn.disabled = false;
        // (stop button is removed inside playTTSwithStop)
      };
      actionRow.appendChild(listenBtn);

      // ===== Download MP3 Button =====
      const downloadBtn = document.createElement('button');
      downloadBtn.textContent = "⬇️";
      downloadBtn.title = "Download this message as MP3";
      downloadBtn.className = "download-btn";
      downloadBtn.onclick = async () => {
        downloadBtn.disabled = true;
        downloadBtn.textContent = "…";
        try {
          await downloadTTS(textForSpeech(msg.content) || msg.content, "English");
        } catch (e) {
          alert("Download failed: " + (e.message||e));
        }
        downloadBtn.textContent = "⬇️";
        downloadBtn.disabled = false;
      };
      actionRow.appendChild(downloadBtn);

      // ===== Copy Button - NEW! =====
      const copyBtn = document.createElement('button');
      copyBtn.textContent = "📋";
      copyBtn.title = "Copy this message text";
      copyBtn.className = "copy-btn";
      copyBtn.onclick = () => {
        copyToClipboard(msg.content);
        copyBtn.textContent = "✅";
        setTimeout(() => { copyBtn.textContent = "📋"; }, 1200);
      };
      actionRow.appendChild(copyBtn);
      // ===== Google Calendar Button - NEW! =====
      const calBtn = document.createElement('button');
      calBtn.textContent = "📅";
      calBtn.title = "Add this message to Google Calendar";
      calBtn.className = "calendar-btn";
      calBtn.onclick = () => addToGoogleCalendar(msg.content);
      actionRow.appendChild(calBtn);
      // Delete button
      const delBtn = document.createElement('button');
      delBtn.textContent = "🗑️";
      delBtn.title = "Delete this message";
      delBtn.className = "msg-delete-btn";
      delBtn.onclick = () => deleteMessage(msg.id);
      actionRow.appendChild(delBtn);

      chatWindow.appendChild(actionRow);
    }

    // ====== If user message, action row is edit/copy/calendar/trash ======
    if (msg.role === "user") {
      const actionRow = document.createElement('div');
      actionRow.className = "action-row";
      // ===== Edit Button =====
      const editBtn = document.createElement('button');
      editBtn.textContent = "✏️";
      editBtn.title = "Edit and resend this message";
      editBtn.className = "edit-btn";
      editBtn.onclick = () => startEdit(msg);
      actionRow.appendChild(editBtn);
      // ===== Copy Button - NEW! =====
      const copyBtn = document.createElement('button');
      copyBtn.textContent = "📋";
      copyBtn.title = "Copy this message text";
      copyBtn.className = "copy-btn";
      copyBtn.onclick = () => {
        copyToClipboard(msg.content);
        copyBtn.textContent = "✅";
        setTimeout(() => { copyBtn.textContent = "📋"; }, 1200);
      };
      actionRow.appendChild(copyBtn);
      // ===== Google Calendar Button - NEW! =====
      const calBtn = document.createElement('button');
      calBtn.textContent = "📅";
      calBtn.title = "Add this message to Google Calendar";
      calBtn.className = "calendar-btn";
      calBtn.onclick = () => addToGoogleCalendar(msg.content);
      actionRow.appendChild(calBtn);
      const delBtn = document.createElement('button');
      delBtn.textContent = "🗑️";
      delBtn.title = "Delete this message";
      delBtn.className = "msg-delete-btn";
      delBtn.onclick = () => deleteMessage(msg.id);
      actionRow.appendChild(delBtn);
      chatWindow.appendChild(actionRow);
    }

    // ---- SUGGESTION BUTTONS after [the last assistant message only, and only if we have suggestions] ----
    // Uses suggestions from memory, or the ones saved in the database
    const suggArr = (lastSuggestions && lastSuggestions[msg.id]) || msg.suggestions;
    if (msg.role === "assistant" && idx === lastAssistantIdx && Array.isArray(suggArr) && suggArr.some(Boolean)) {
      const sugg = document.createElement('div');
      sugg.className = 'suggestions';
      for(let i=0; i<3; ++i) {
        const btn = document.createElement('button');
        btn.className = 'sugg-btn';
        btn.type = 'button';
        btn.textContent = suggArr[i] || "";
        btn.disabled = !suggArr[i];
        btn.onclick = () => sendSuggestion(i, suggArr, msg, idx);
        sugg.appendChild(btn);
      }
      chatWindow.appendChild(sugg);
    }
    // End suggestions
  });
  scrollToBottomIfNear(chatWindow);
}

// ======= Download TTS as concatenated MP3 file =======
async function downloadTTS(text, language) {
  const chunks = splitTextIntoChunks(text, 1000);
  let audioBlobs = [];
  try {
    const headers = await authHeaders();
    audioBlobs = await Promise.all(chunks.map(chunk =>
      fetch("/.netlify/functions/tts", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: chunk, language })
      })
      .then(resp => {
        if (!resp.ok) throw new Error("TTS error: " + resp.statusText);
        return resp.blob();
      })
    ));
  } catch (e) {
    alert("Could not fetch audio: " + (e.message||e));
    return;
  }

  // Combine all chunks into one Blob
  const fullBlob = new Blob(audioBlobs, { type: "audio/mpeg" });

  // Download
  const url = URL.createObjectURL(fullBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = "chat-audio.mp3";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 8000); // Clean up
}

// ======= Play TTS function: plays chunk 1 as soon as it is ready, the rest load in the background =======
async function playTTSwithStop(text, language, containerEl, listenBtn) {
  // Short first chunk (~250 chars) so audio starts fast, the rest ~1000 chars
  const chunks = splitTextIntoChunks(text, 1000, 250);
  stopTTSPlayback(); // If last playback was still there, stop it
  ttsState.stopRequested = false;
  ttsState.audios = [];
  // Each playback gets its own id. Starting a new one stops the old one.
  const myId = (ttsState.playId || 0) + 1;
  ttsState.playId = myId;
  const stopped = () => ttsState.stopRequested || ttsState.playId !== myId;
  // Create a Stop button and show in the container next to Listen
  let stopBtn = document.createElement('button');
  stopBtn.textContent = "⏹️ Stop";
  stopBtn.title = "Stop reading aloud";
  stopBtn.style.fontSize = "1em";
  stopBtn.style.background = "#f5b3b3";
  stopBtn.style.borderRadius = "6px";
  stopBtn.style.border = "none";
  stopBtn.style.marginLeft = "10px";
  stopBtn.style.padding = "0.2em 1.1em";
  stopBtn.style.cursor = "pointer";
  stopBtn.onclick = stopTTSPlayback;
  removeStopBtn();
  containerEl.appendChild(stopBtn);
  ttsState.stopBtn = stopBtn;
  try {
    const headers = await authHeaders();
    // Start ALL requests now (in parallel), but don't wait for all of them
    const blobPromises = chunks.map(chunk =>
      fetch("/.netlify/functions/tts", {
        method: "POST",
        headers,
        body: JSON.stringify({ text: chunk, language })
      })
      .then(resp => {
        if (!resp.ok) throw new Error("TTS error: " + resp.statusText);
        return resp.blob();
      })
    );
    // Avoid "unhandled error" warnings for chunks we never reach (e.g. after Stop)
    blobPromises.forEach(p => p.catch(() => {}));
    for (let i = 0; i < blobPromises.length; i++) {
      if (stopped()) break;
      // Chunk 1: waits only for itself. Later chunks are usually ready already.
      const blob = await blobPromises[i];
      if (stopped()) break;
      const url = URL.createObjectURL(blob);
      try {
        await new Promise((resolve, reject) => {
          const audio = new Audio(url);
          ttsState.audios.push(audio);
          // If stop is requested while playing, end this chunk immediately
          const interval = setInterval(() => {
            if (stopped()) {
              clearInterval(interval);
              audio.pause();
              resolve();
            }
          }, 160);
          audio.onended = () => { clearInterval(interval); resolve(); };
          audio.onerror = () => { clearInterval(interval); reject(new Error("Audio playback error")); };
          audio.play().catch(err => { clearInterval(interval); reject(err); });
        });
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } finally {
    // Only clean up if no newer playback has started meanwhile
    if (ttsState.playId === myId) {
      removeStopBtn();
      ttsState.stopRequested = false;
      ttsState.audios = [];
    }
  }
}

// Helper: Stop playback immediately
function stopTTSPlayback() {
  ttsState.stopRequested = true;
  // Stop all in-progress
  for (const audio of ttsState.audios) {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch(e){}
  }
  ttsState.audios = [];
  removeStopBtn();
}

// Remove the stop button (if present)
function removeStopBtn() {
  if (ttsState.stopBtn && ttsState.stopBtn.parentNode) {
    ttsState.stopBtn.parentNode.removeChild(ttsState.stopBtn);
  }
  ttsState.stopBtn = null;
}
// ======= END Play TTS =======

// Send suggestion as new user message, and trigger chat as if typed
async function sendSuggestion(idx, suggArr, assistantMsg, assistantMsgIdx) {
  const suggestionText = suggArr[idx];
  if (!suggestionText) return;
  // Add to db as user message
  await addMessage("user", suggestionText);
  userInput.value = '';
  autoGrow(userInput);
  // Live-updating bubble while the reply streams in
  const streamDiv = document.createElement('div');
  streamDiv.className = 'assistant';
  streamDiv.textContent = '';
  chatWindow.appendChild(streamDiv);
  scrollToBottomIfNear(chatWindow);
  // messages already contains the new user message (addMessage reloads it)
  const contextMessages = buildContextMessages();
  const selectedModel = modelDropdown.value;
  await streamChatWithContinue(contextMessages, selectedModel, {
    onChunk: (partial) => {
      if (md) {
        streamDiv.innerHTML = md.render(partial);
      } else {
        streamDiv.textContent = partial;
      }
      scrollToBottomIfNear(chatWindow);
    },
    onDone: async (fullReply, meta) => {
      const sugg = (meta && meta.suggestions) || ["", "", ""];
      await addMessage("assistant", fullReply, sugg);
      await loadMessages();
      const lastMsg = messages[messages.length - 1];
      lastSuggestions[lastMsg.id] = sugg;
      renderAll();
    },
    onError: (errMsg) => {
      streamDiv.remove();
      const errDiv = document.createElement('div');
      errDiv.className = 'system';
      errDiv.textContent = "Error: " + errMsg;
      chatWindow.appendChild(errDiv);
    }
  });
}

function renderAll() {
  renderTopicsDropdown();
  renderChat();
  autoGrow(userInput); // Ensure input box size is right for quick typing
  // ---- CHANGED FROM: if (user) userInput.focus();
  // Do NOT focus userInput automatically. This prevents unwanted mobile keyboard popup
  // OLD: if (user) userInput.focus();
}

// ===== Textarea Auto-expanding =====
function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = (textarea.scrollHeight) + "px";
}
userInput.addEventListener("input", function() {
  autoGrow(this);
});
// ====== EDIT USER MESSAGE ======
let editingMsg = null; // the user message being edited (null = not editing)
const cancelEditBtn = document.getElementById("cancelEditBtn");
function startEdit(msg) {
  editingMsg = msg;
  userInput.value = msg.content;
  autoGrow(userInput);
  userInput.focus();
  chatForm.querySelector('button[type="submit"]').textContent = "Resend";
  cancelEditBtn.style.display = "";
}
function cancelEdit() {
  editingMsg = null;
  userInput.value = "";
  autoGrow(userInput);
  chatForm.querySelector('button[type="submit"]').textContent = "Send";
  cancelEditBtn.style.display = "none";
}
cancelEditBtn.onclick = cancelEdit;
// Deletes this message and every message after it (in the current topic)
async function deleteFromMessage(msg) {
  const { error } = await supabase
    .from('messages')
    .delete()
    .eq('topic_id', topics[activeTopicIdx].id)
    .gte('created_at', msg.created_at);
  if (error) { alert(error.message); return false; }
  return true;
}
// ====== END EDIT USER MESSAGE ======
// ===== Chat Submit =====
let isSending = false;
chatForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;
  if (!topics[activeTopicIdx]) return;
  if (isSending) return;
  isSending = true;
  const sendBtn = chatForm.querySelector('button[type="submit"]');
  sendBtn.disabled = true;
  sendBtn.textContent = "…";
  // If editing: remove the old message and everything after it first
  if (editingMsg) {
    const ok = await deleteFromMessage(editingMsg);
    if (!ok) {
      isSending = false;
      sendBtn.disabled = false;
      sendBtn.textContent = "Resend";
      return;
    }
    editingMsg = null;
    cancelEditBtn.style.display = "none";
  }
  await addMessage("user", text);
  userInput.value = '';
  autoGrow(userInput);
  // Live-updating bubble while the reply streams in
  const streamDiv = document.createElement('div');
  streamDiv.className = 'assistant';
  streamDiv.textContent = '';
  chatWindow.appendChild(streamDiv);
  scrollToBottomIfNear(chatWindow);
  // messages already contains the new user message (addMessage reloads it)
  const contextMessages = buildContextMessages();
  const selectedModel = modelDropdown.value;
  await streamChatWithContinue(contextMessages, selectedModel, {
    onChunk: (partial) => {
      if (md) {
        streamDiv.innerHTML = md.render(partial);
      } else {
        streamDiv.textContent = partial;
      }
      scrollToBottomIfNear(chatWindow);
    },
    onDone: async (fullReply, meta) => {
      const sugg = (meta && meta.suggestions) || ["", "", ""];
      await addMessage("assistant", fullReply, sugg);
      await loadMessages();
      const lastMsg = messages[messages.length - 1];
      lastSuggestions[lastMsg.id] = sugg;
      renderAll();
    },
    onError: (errMsg) => {
      streamDiv.remove();
      const errDiv = document.createElement('div');
      errDiv.className = 'system';
      errDiv.textContent = "Error: " + errMsg;
      chatWindow.appendChild(errDiv);
    }
  });
  isSending = false;
  sendBtn.disabled = false;
  sendBtn.textContent = "Send";
};

const showSheetBtn = document.getElementById("showSheetBtn");
const sheetDataDiv = document.getElementById("sheetData");
// Sheets to choose from (key must match SHEETS in netlify/functions/sheet.js)
const SHEET_CHOICES = [
  { key: "Activities", label: "Activities" },
  { key: "FootballSessions", label: "Football Sessions" },
  { key: "HiddenPotential", label: "Hidden Potential" },
  { key: "MakerLog", label: "Maker Log" },
];
// Click 📄 -> show/hide the chooser
showSheetBtn.onclick = function() {
  if (sheetDataDiv.style.display !== "none") {
    sheetDataDiv.style.display = "none";
    return;
  }
  sheetDataDiv.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = "Load sheet:";
  label.style.marginRight = "4px";
  sheetDataDiv.appendChild(label);
  for (const choice of SHEET_CHOICES) {
    const btn = document.createElement("button");
    btn.type = "button"; // important: don't submit the chat form
    btn.textContent = choice.label;
    btn.style.padding = "0.3em 0.9em";
    btn.style.fontSize = "0.95em";
    btn.onclick = () => loadSheet(choice.key, choice.label);
    sheetDataDiv.appendChild(btn);
  }
  sheetDataDiv.style.display = "flex";
};
// Fetch the chosen sheet and insert it into the input box
async function loadSheet(key, label) {
  sheetDataDiv.innerHTML = "<span>Loading " + label + "…</span>";
  try {
    const resp = await fetch("/.netlify/functions/sheet?sheet=" + encodeURIComponent(key), { headers: await authHeaders() });
    const data = await resp.json();
    if (!data || data.error) {
      alert("Error loading sheet: " + ((data && data.error) || "Unknown"));
      return;
    }
    if (!data.rows || !data.rows.length) {
      alert("No data in sheet.");
      return;
    }
    // Compose as pipe-separated table (markdown style), one row per line.
    // Every row has exactly the same number of cells, so empty cells keep their position.
    const clean = v => (String(v ?? "").trim() === "" ? "–" : String(v))
      .replace(/\r?\n/g, " ")   // line breaks inside a cell -> space
      .replace(/\|/g, "\\|")    // escape pipes inside a cell
      .trim();
    const line = cells => "| " + cells.map(clean).join(" | ") + " |";
    let text = "Sheet: " + label + " (" + data.headers.length + " columns, separated by |, empty cells are blank)\n";
    text += line(data.headers) + "\n";
    text += "|" + data.headers.map(() => "---").join("|") + "|\n";
    for (const row of data.rows) {
      text += line(row) + "\n";
    }
    // Insert into userInput area (keeping any previous value)
    userInput.value = text + "\n" + userInput.value;
    autoGrow(userInput);
    userInput.focus();
  } catch (e) {
    alert("Error loading sheet: " + (e.message || e));
  } finally {
    sheetDataDiv.style.display = "none";
  }
}

// ====== FOOTBALL DASHBOARD ======
const DASH_SHEET_KEY = "FootballSessions"; // must match a key in netlify/functions/sheet.js
const dashboardBtn = document.getElementById("dashboardBtn");
const dashboardPanel = document.getElementById("dashboardPanel");
const dashColumn = document.getElementById("dashColumn");
const dashColumn2 = document.getElementById("dashColumn2");
const dashColumn3 = document.getElementById("dashColumn3");
const DASH_COLORS = ["#3b6fd8", "#d83b6f", "#2ca05a"]; // blue, red, green
const dashStats = document.getElementById("dashStats");
const dashAskBtn = document.getElementById("dashAskBtn");
const dashCloseBtn = document.getElementById("dashCloseBtn");
let dashData = null;   // { headers, rows }
let dashChart = null;  // Chart.js instance
let dashXCol = 0;      // index of the date column
// "7,5" -> 7.5, "80%" -> 80, "" or text -> null
function dashParseNum(v) {
  let s = String(v ?? "").trim().replace(/\s/g, "").replace(/%$/, "");
  if (s === "") return null;
  s = s.replace(",", ".");
  const n = Number(s);
  return isFinite(n) ? n : null;
}
// Find the date column by header name, otherwise use the first column
function dashFindDateColumn(headers) {
  const idx = headers.findIndex(h => /date|dato|datum|day/i.test(h));
  return idx >= 0 ? idx : 0;
}
// Simple linear trend line (least squares)
function dashTrend(values) {
  const n = values.length;
  if (n < 2) return values.map(() => null);
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  values.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const intercept = (sy - slope * sx) / n;
  return values.map((_, x) => Math.round((intercept + slope * x) * 100) / 100);
}
// Collect the points (date label + number) for the selected column
function dashGetPoints(col) {
  return dashData.rows
    .map(r => ({ label: r[dashXCol] || "", y: dashParseNum(r[col]) }))
    .filter(p => p.y !== null);
}
// Returns the selected column indexes (1 to 3, no duplicates)
function dashSelectedCols() {
  const cols = [];
  for (const sel of [dashColumn, dashColumn2, dashColumn3]) {
    const c = parseInt(sel.value);
    if (!isNaN(c) && !cols.includes(c)) cols.push(c);
  }
  return cols;
}
// Stats text for one column
function dashStatsText(values) {
  if (!values.length) return "No numbers in this column.";
  const first = values[0];
  const last = values[values.length - 1];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const change = last - first;
  return "Latest: " + last +
    "  |  Change: " + (change >= 0 ? "+" : "") + Math.round(change * 100) / 100 +
    "  |  Min: " + min + "  |  Max: " + max +
    "  |  Avg: " + Math.round(avg * 100) / 100 +
    "  |  Sessions: " + values.length;
}
function drawDashChart() {
  if (!dashData) return;
  const cols = dashSelectedCols();
  if (!cols.length) return;
  // Remember the choices in all 3 dropdowns
  [dashColumn, dashColumn2, dashColumn3].forEach((sel, n) => {
    const c = parseInt(sel.value);
    localStorage.setItem("dashColumnName" + (n ? n + 1 : ""), isNaN(c) ? "" : dashData.headers[c]);
  });
  // Rows where at least one selected column has a number
  const rows = dashData.rows.filter(r => cols.some(c => dashParseNum(r[c]) !== null));
  const labels = rows.map(r => r[dashXCol] || "");
  // Stats: one line per selected skill
  if (cols.length === 1) {
    dashStats.textContent = dashStatsText(dashGetPoints(cols[0]).map(p => p.y));
  } else {
    dashStats.textContent = cols
      .map(c => dashData.headers[c] + ": " + dashStatsText(dashGetPoints(c).map(p => p.y)))
      .join("\n");
  }
  if (typeof Chart === "undefined") {
    dashStats.textContent = "Chart library not loaded (check internet / index.html).";
    return;
  }
  // One line per selected skill (null = no value that day)
  const datasets = cols.map((c, n) => ({
    label: dashData.headers[c],
    data: rows.map(r => dashParseNum(r[c])),
    borderColor: DASH_COLORS[n],
    backgroundColor: DASH_COLORS[n],
    tension: 0.25,
    pointRadius: 4,
    spanGaps: true
  }));
  // Trend line only when exactly 1 skill is selected
  if (cols.length === 1) {
    datasets.push({
      label: "Trend",
      data: dashTrend(datasets[0].data),
      borderColor: "#e08a2c",
      borderDash: [6, 4],
      pointRadius: 0,
      fill: false
    });
  }
  if (dashChart) dashChart.destroy();
  dashChart = new Chart(document.getElementById("dashChart"), {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { min: 1, max: 5, ticks: { stepSize: 1 } } },
      plugins: { legend: { position: "bottom" } }
    }
  });
}
// Open dashboard: always fetch fresh data from the sheet
dashboardBtn.onclick = async () => {
  dashboardPanel.style.display = "flex";
  dashStats.textContent = "Loading…";
  dashColumn.innerHTML = "";
  try {
    const resp = await fetch("/.netlify/functions/sheet?sheet=" + encodeURIComponent(DASH_SHEET_KEY), { headers: await authHeaders() });
    const data = await resp.json();
    if (!data || data.error) throw new Error((data && data.error) || "Unknown error");
    if (!data.rows || !data.rows.length) throw new Error("No data in sheet.");
    dashData = data;
    dashXCol = dashFindDateColumn(data.headers);
    // Only offer columns that contain at least 2 numbers
    const numericCols = data.headers
      .map((h, i) => i)
      .filter(i => i !== dashXCol && data.rows.filter(r => dashParseNum(r[i]) !== null).length >= 2);
    if (!numericCols.length) throw new Error("No numeric columns found.");
    // Dropdowns 2 and 3 start with a "none" option
    for (const sel of [dashColumn2, dashColumn3]) {
      sel.innerHTML = "";
      const none = document.createElement("option");
      none.value = "";
      none.textContent = "(compare: none)";
      sel.appendChild(none);
    }
    for (const i of numericCols) {
      for (const sel of [dashColumn, dashColumn2, dashColumn3]) {
        const opt = document.createElement("option");
        opt.value = i;
        opt.textContent = data.headers[i];
        sel.appendChild(opt);
      }
    }
    // Remember last chosen columns
    const restore = (sel, storageKey) => {
      const savedIdx = data.headers.indexOf(localStorage.getItem(storageKey));
      if (savedIdx >= 0 && numericCols.includes(savedIdx)) sel.value = savedIdx;
    };
    restore(dashColumn, "dashColumnName");
    restore(dashColumn2, "dashColumnName2");
    restore(dashColumn3, "dashColumnName3");
    drawDashChart();
  } catch (e) {
    dashStats.textContent = "Error: " + (e.message || e);
  }
};
dashColumn.onchange = drawDashChart;
dashColumn2.onchange = drawDashChart;
dashColumn3.onchange = drawDashChart;
dashCloseBtn.onclick = () => { dashboardPanel.style.display = "none"; };
// Click on dark background closes too
dashboardPanel.onclick = (e) => {
  if (e.target === dashboardPanel) dashboardPanel.style.display = "none";
};
// Put the selected column into the chat box so the AI can analyse it
dashAskBtn.onclick = () => {
  if (!dashData) return;
  const cols = dashSelectedCols();
  if (!cols.length) return;
  const names = cols.map(c => "\"" + dashData.headers[c] + "\"").join(", ");
  let text = "Football skill development for " + names + " (" +
    dashData.headers[dashXCol] + ": value):\n";
  for (const c of cols) {
    if (cols.length > 1) text += "\n" + dashData.headers[c] + ":\n";
    for (const p of dashGetPoints(c)) text += p.label + ": " + p.y + "\n";
  }
  text += cols.length > 1
    ? "\nAnalyse and compare the development of these skills, describe the trends, and suggest what to train next."
    : "\nAnalyse the development, describe the trend, and suggest what to train next.";
  userInput.value = text + (userInput.value ? "\n\n" + userInput.value : "");
  autoGrow(userInput);
  dashboardPanel.style.display = "none";
  userInput.focus();
};
// ====== END FOOTBALL DASHBOARD ======
// ====== IMAGE GENERATION (🎨) ======
// Image is downloaded only. NOT saved in the database or the chat.
const imageBtn = document.getElementById("imageBtn");
const imagePanel = document.getElementById("imagePanel");
const imagePrompt = document.getElementById("imagePrompt");
const imageModel = document.getElementById("imageModel");
const imageQuality = document.getElementById("imageQuality");
const imageShape = document.getElementById("imageShape");
const imageStatus = document.getElementById("imageStatus");
const imagePreview = document.getElementById("imagePreview");
const imageGenerateBtn = document.getElementById("imageGenerateBtn");
const imageDownloadBtn = document.getElementById("imageDownloadBtn");
const imageCloseBtn = document.getElementById("imageCloseBtn");
let imageBlobUrl = null;   // temporary URL for the last image (memory only)
let imageFileName = "";
let imageBusy = false;
// base64 text -> Blob (file in memory)
function base64ToBlob(b64, mime) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
// Start a download of the current image
function imageDownload() {
  if (!imageBlobUrl) return;
  const a = document.createElement("a");
  a.href = imageBlobUrl;
  a.download = imageFileName || "image.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
// Remove preview and free memory
function imageClearPreview() {
  imagePreview.style.display = "none";
  imagePreview.removeAttribute("src");
  imageDownloadBtn.style.display = "none";
  if (imageBlobUrl) URL.revokeObjectURL(imageBlobUrl);
  imageBlobUrl = null;
}
// Quality only works for GPT Image (Gemini has no quality setting)
function imageUpdateQuality() {
  imageQuality.disabled = /^gemini/i.test(imageModel.value);
}
// Remember the choices for next time
function imageSaveChoices() {
  localStorage.setItem("imageModel", imageModel.value);
  localStorage.setItem("imageQuality", imageQuality.value);
  localStorage.setItem("imageShape", imageShape.value);
}
function imageRestoreChoices() {
  const restore = (sel, key) => {
    const v = localStorage.getItem(key);
    if (v && [...sel.options].some(o => o.value === v)) sel.value = v;
  };
  restore(imageModel, "imageModel");
  restore(imageQuality, "imageQuality");
  restore(imageShape, "imageShape");
}
function closeImagePanel() {
  imagePanel.style.display = "none";
  imageClearPreview();
  if (!imageBusy) imageStatus.textContent = "";
}
imageBtn.onclick = () => {
  // Use the text from the chat box as prompt (if there is any)
  if (userInput.value.trim()) imagePrompt.value = userInput.value.trim();
  imageRestoreChoices();
  imageUpdateQuality();
  imagePanel.style.display = "flex";
  imagePrompt.focus();
};
imageModel.onchange = imageUpdateQuality;
imageCloseBtn.onclick = closeImagePanel;
imageDownloadBtn.onclick = imageDownload;
// Click on dark background closes too
imagePanel.onclick = (e) => {
  if (e.target === imagePanel) closeImagePanel();
};
// Escape closes, Ctrl+Enter generates
imagePrompt.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeImagePanel();
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) imageGenerateBtn.click();
});
imageGenerateBtn.onclick = async () => {
  const prompt = imagePrompt.value.trim();
  if (!prompt) { imageStatus.textContent = "Please write what the image should show."; return; }
  if (imageBusy) return;
  imageBusy = true;
  imageSaveChoices();
  imageClearPreview();
  imageGenerateBtn.disabled = true;
  imageGenerateBtn.textContent = "…";
  const start = Date.now();
  imageStatus.textContent = "Generating… (can take up to 1 minute)";
  const timer = setInterval(() => {
    imageStatus.textContent = "Generating… " + Math.round((Date.now() - start) / 1000) + "s (can take up to 1 minute)";
  }, 1000);
  try {
    const resp = await fetch("/api/image", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        prompt,
        model: imageModel.value,
        quality: imageQuality.value,
        shape: imageShape.value
      })
    });
    // The answer is some empty "keep-alive" lines + one JSON line at the end
    const text = await resp.text();
    const lastLine = text.trim().split("\n").pop() || "";
    let data;
    try { data = JSON.parse(lastLine); }
    catch (e) { throw new Error("Bad answer from server (status " + resp.status + ")"); }
    if (data.error) throw new Error(data.error);
    if (!data.b64) throw new Error("No image received");
    const mime = data.mime || "image/png";
    const ext = mime.includes("jpeg") ? "jpg" : (mime.split("/")[1] || "png");
    imageFileName = "image-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + "." + ext;
    imageBlobUrl = URL.createObjectURL(base64ToBlob(data.b64, mime));
    imageDownload();
    if (imagePanel.style.display !== "none") {
      // Popup still open: show temporary preview (disappears when closed)
      imagePreview.src = imageBlobUrl;
      imagePreview.style.display = "block";
      imageDownloadBtn.style.display = "";
      imageStatus.textContent = "Done ✅ Image downloaded (" + Math.round((Date.now() - start) / 1000) + "s). On iPhone: long-press the image to save it.";
    } else {
      // Popup was closed while waiting: just download, then free memory
      const url = imageBlobUrl;
      imageBlobUrl = null;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      imageStatus.textContent = "";
    }
  } catch (e) {
    imageStatus.textContent = "Error: " + (e.message || e);
  } finally {
    clearInterval(timer);
    imageBusy = false;
    imageGenerateBtn.disabled = false;
    imageGenerateBtn.textContent = "Generate";
  }
};
// ====== END IMAGE GENERATION ======
// ==== INIT ===
window.onload = async () => {
  let { data: { user: u }} = await supabase.auth.getUser();
  user = u;
  updateAuthUI();
  if (user) await loadData();
  // ---- CHANGED: Do NOT focus here ----
  // Don't auto-focus userInput on load
};
// ==== PWA: register service worker (makes "Add to Home Screen" work as an app) ====
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}