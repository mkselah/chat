import { supabase } from "./setup.js";

const topicDropdown = document.getElementById("topicDropdown");
const addTopicBtn = document.getElementById("addTopicBtn");
const renameTopicBtn = document.getElementById("renameTopicBtn");
const deleteTopicBtn = document.getElementById("deleteTopicBtn");
const logoutBtn = document.getElementById("logoutBtn"); // Only one logoutBtn now!

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

let topics = [];
let messages = [];
let activeTopicIdx = 0;
let user = null;

// New: To hold suggestions for last assistant message (index = message #)
let lastSuggestions = {}; // { messageId: [suggestion1, suggestion2, suggestion3] }

// ====== TTS State =======
let ttsState = {
  stopRequested: false,
  audios: [],
  stopBtn: null, // The stop button element
};
// === /End TTS state ===

// --- Add to script.js: splits long text into ~1000 char chunks at ".", "!", "?"
function splitTextIntoChunks(text, charLimit = 1000) {
  if (text.length <= charLimit) return [text];
  const sentences = text.match(/[^.!?]+[.!?]+|\s*\S+$/g); // naive sentence split
  const chunks = [];
  let current = "";
  for (const sent of sentences) {
    if ((current + sent).length > charLimit) {
      if (current) chunks.push(current);
      current = sent.trim();
    } else {
      current += sent;
    }
  }
  if (current) chunks.push(current);
  return chunks;
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
  if (!topics.length) activeTopicIdx = 0;
  else if (activeTopicIdx >= topics.length) activeTopicIdx = 0;
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
  let { data, error } = await supabase
    .from('topics')
    .insert({ name, user_id: user.id })
    .select();
  if (error) return alert(error.message);
  topics.push(data[0]);
  activeTopicIdx = topics.length - 1;
  await loadMessages();
  renderAll();
}

async function renameTopic(idx, name) {
  if (!user || !topics[idx]) return;
  let id = topics[idx].id;
  let { error } = await supabase
    .from('topics')
    .update({ name })
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
  if (activeTopicIdx >= topics.length) activeTopicIdx = topics.length - 1;
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

// Add message
async function addMessage(role, content) {
  if (!user || !topics[activeTopicIdx]) return;
  let { error } = await supabase
    .from('messages')
    .insert({
      topic_id: topics[activeTopicIdx].id,
      role,
      content,
    });
  if (error) alert(error.message);
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
    opt.textContent = t.name;
    topicDropdown.appendChild(opt);
  });
  topicDropdown.value = activeTopicIdx;
  // Hide rename/delete if no topics
  renameTopicBtn.disabled = deleteTopicBtn.disabled = topics.length === 0;
  if(topics[activeTopicIdx]) {
    document.getElementById('currentTopicLabel').textContent = "  (" + topics[activeTopicIdx].name + ")";
  } else {
    document.getElementById('currentTopicLabel').textContent = '';
  }
}
topicDropdown.onchange = async function () {
  activeTopicIdx = parseInt(this.value);
  await loadMessages();
  renderAll();
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

// === MODIFIED: Chat area w/ delete message support and suggestion buttons and LISTEN BUTTON ===
function renderChat() {
  chatWindow.innerHTML = '';
  if (!topics[activeTopicIdx]) return;
  // For suggestions: find last assistant message and see if we have suggestions for it
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; --i) {
    if (messages[i].role === "assistant") { lastAssistantIdx = i; break; }
  }

  messages.forEach((msg, idx) => {
    // Create bubble row (no longer flex)
    const div = document.createElement('div');
    div.className = msg.role;

    // --- Message content as before ---
    if (msg.role === "assistant") {
      // Use Markdown rendering for assistant
      if (window.markdownit) {
        div.innerHTML = window.markdownit().render(msg.content);
      } else {
        div.innerHTML = msg.content.replace(/\n\n/g, "<br><br>").replace(/\n/g, "<br>");
      }
    } else {
      div.textContent = msg.content;
    }

    chatWindow.appendChild(div);

    // ====== Action row for assistant: Listen/Download/Trash in new row below bubble ======
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
        // === CHANGES HERE: Remove any previous stop button
        removeStopBtn();
        try {
          await playTTSwithStop(msg.content, "English", actionRow, listenBtn);
        } catch (e) {
          alert("Could not play audio: " + (e.message||e));
        }
        listenBtn.textContent = "🔊";
        listenBtn.disabled = false;
        removeStopBtn();
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
          await downloadTTS(msg.content, "English");
        } catch (e) {
          alert("Download failed: " + (e.message||e));
        }
        downloadBtn.textContent = "⬇️";
        downloadBtn.disabled = false;
      };
      actionRow.appendChild(downloadBtn);

      // Delete button
      const delBtn = document.createElement('button');
      delBtn.textContent = "🗑️";
      delBtn.title = "Delete this message";
      delBtn.className = "msg-delete-btn";
      delBtn.onclick = () => deleteMessage(msg.id);
      actionRow.appendChild(delBtn);

      chatWindow.appendChild(actionRow);
    }

    // ====== If user message, action row is just trash ======
    if (msg.role === "user") {
      const actionRow = document.createElement('div');
      actionRow.className = "action-row";
      const delBtn = document.createElement('button');
      delBtn.textContent = "🗑️";
      delBtn.title = "Delete this message";
      delBtn.className = "msg-delete-btn";
      delBtn.onclick = () => deleteMessage(msg.id);
      actionRow.appendChild(delBtn);
      chatWindow.appendChild(actionRow);
    }

    // ---- SUGGESTION BUTTONS after [the last assistant message only, and only if we have suggestions] ----
    if (msg.role === "assistant" && idx === lastAssistantIdx && lastSuggestions && lastSuggestions[msg.id]) {
      const suggArr = lastSuggestions[msg.id];
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
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// ======= Download TTS as concatenated MP3 file =======
async function downloadTTS(text, language) {
  const chunks = splitTextIntoChunks(text, 1000);
  let audioBlobs = [];

  try {
    audioBlobs = await Promise.all(chunks.map(chunk =>
      fetch("/.netlify/functions/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

// ======= Play TTS function: Queued, Prefetches all chunks and plays in sequence =======
async function playTTSwithStop(text, language, containerEl, listenBtn) {
  const chunks = splitTextIntoChunks(text, 1000);
  let audioBlobs = []; // If last playback was still there, try to stop it
  stopTTSPlayback();

  ttsState.stopRequested = false;
  ttsState.audios = [];

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
  // Remove any old stop button
  removeStopBtn();
  containerEl.appendChild(stopBtn);
  ttsState.stopBtn = stopBtn;

  try {
    audioBlobs = await Promise.all(chunks.map(chunk =>
      fetch("/.netlify/functions/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk, language })
      })
      .then(resp => {
        if (!resp.ok) throw new Error("TTS error: " + resp.statusText);
        return resp.blob();
      })
    ));
  } catch (e) {
    removeStopBtn();
    throw e;
  }

  const audioUrls = audioBlobs.map(blob => URL.createObjectURL(blob));
  try {
    for (let i = 0; i < audioUrls.length; i++) {
      if (ttsState.stopRequested) break;
      await new Promise((resolve, reject) => {
        const audio = new Audio(audioUrls[i]);
        ttsState.audios.push(audio);
        audio.onended = () => {
          URL.revokeObjectURL(audioUrls[i]);
          resolve();
        };
        audio.onerror = (err) => {
          URL.revokeObjectURL(audioUrls[i]);
          reject(err);
        };
        audio.play();
        // If stop requested while playing, pause/abort immediately
        let interval = setInterval(() => {
          if (ttsState.stopRequested) {
            audio.pause();
            audio.currentTime = 0;
            clearInterval(interval);
            URL.revokeObjectURL(audioUrls[i]);
            resolve();
          }
        }, 160);
      });
    }
  } finally {
    removeStopBtn();
    ttsState.stopRequested = false;
    for (const url of audioUrls) URL.revokeObjectURL(url);
    ttsState.audios = [];
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
  chatWindow.innerHTML += "<div class='system'>Thinking…</div>";
  chatWindow.scrollTop = chatWindow.scrollHeight;

  // Build context messages: all up to and incl current
  const contextMessages = messages.concat(
    [{ role: "user", content: suggestionText }]
  );
  // Call Netlify function
  const resp = await fetch("/.netlify/functions/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: contextMessages }),
  });
  const json = await resp.json();
  if (json.reply) {
    // Add assistant message to DB
    await addMessage("assistant", json.reply);
    // Store new suggestions for that message
    // We'll use the last message's id (will be loaded via addMessage)
    await loadMessages(); // will update messages with new assistant
    const lastMsg = messages[messages.length - 1];
    lastSuggestions[lastMsg.id] = json.suggestions || ["", "", ""];
    renderAll();
  } else {
    chatWindow.innerHTML += "<div class='system'>Error: "+(json.error||"Unknown")+"</div>";
  }
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

// ===== Chat Submit =====
chatForm.onsubmit = async (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;
  if (!topics[activeTopicIdx]) return;
  await addMessage("user", text);
  userInput.value = '';
  autoGrow(userInput);
  chatWindow.innerHTML += "<div class='system'>Thinking…</div>";
  chatWindow.scrollTop = chatWindow.scrollHeight;

  // Build context messages
  const contextMessages = messages.concat([{ role: "user", content: text }]);
  // Call Netlify function
  const resp = await fetch("/.netlify/functions/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: contextMessages }),
  });
  const json = await resp.json();
  if (json.reply) {
    await addMessage("assistant", json.reply);
    // Save the suggestions with this message ID (but only after re-loading messages to get the new ID)
    await loadMessages();
    const lastMsg = messages[messages.length-1];
    lastSuggestions[lastMsg.id] = json.suggestions || ["", "", ""];
    renderAll();
  } else {
    chatWindow.innerHTML += "<div class='system'>Error: "+(json.error||"Unknown")+"</div>";
  }
};

const showSheetBtn = document.getElementById("showSheetBtn");
const sheetDataDiv = document.getElementById("sheetData");

showSheetBtn.onclick = async function() {
  const resp = await fetch("/.netlify/functions/sheet");
  const rows = await resp.json();
  if (!rows || rows.error) {
    alert("Error loading sheet: " + (rows.error || "Unknown"));
    return;
  }
  if (!rows.length) {
    alert("No data in sheet.");
    return;
  }
  // Compose as text (tab-separated, one row per line)
  const headers = Object.keys(rows[0]);
  let text = headers.join("\t") + "\n";
  for (const row of rows) {
    text += headers.map(h => row[h]).join("\t") + "\n";
  }
  // Insert into userInput area (keeping any previous value and putting caret at end)
  userInput.value = text + "\n" + userInput.value;
  autoGrow(userInput);
  userInput.focus();
};

// ==== INIT ===
window.onload = async () => {
  let { data: { user: u }} = await supabase.auth.getUser();
  user = u;
  updateAuthUI();
  if (user) await loadData();
  // ---- CHANGED: Do NOT focus here ----
  // Don't auto-focus userInput on load
};