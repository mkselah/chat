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

// === MODIFIED: Chat area w/ delete message support ===
function renderChat() {
  chatWindow.innerHTML = '';
  if (!topics[activeTopicIdx]) return;
  messages.forEach(msg => {
    const div = document.createElement('div');
    div.className = msg.role;

    // === Add .message-container so the 🗑️ button can float right (CSS not shown!) ===
    const container = document.createElement('div');
    container.className = "message-container";
    container.style.display = 'flex';
    container.style.alignItems = 'flex-start';

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

    // Show a delete button for all messages - you may change to only user/assistant if you want
    const delBtn = document.createElement('button');
    delBtn.textContent = "🗑️";
    delBtn.title = "Delete this message";
    delBtn.className = "msg-delete-btn";
    // small, inline, soft button
    delBtn.style.marginLeft = "8px";
    delBtn.style.fontSize = "1em";
    delBtn.style.background = "none";
    delBtn.style.border = "none";
    delBtn.style.cursor = "pointer";
    delBtn.style.opacity = "0.6";
    delBtn.style.transition = "opacity 0.2s";
    delBtn.onmouseenter = () => delBtn.style.opacity = "1";
    delBtn.onmouseleave = () => delBtn.style.opacity = "0.6";
    delBtn.onclick = () => deleteMessage(msg.id);

    // Optional: Only show delete for your own user messages OR all? For solo use, show always.
    container.appendChild(div);
    container.appendChild(delBtn);

    chatWindow.appendChild(container);
  });
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function renderAll() {
  renderTopicsDropdown();
  renderChat();
  autoGrow(userInput); // Ensure input box size is right for quick typing
  if (user) userInput.focus();
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
  } else {
    chatWindow.innerHTML += "<div class='system'>Error: "+(json.error||"Unknown")+"</div>";
  }
};

// ==== INIT ===
window.onload = async () => {
  let { data: { user: u }} = await supabase.auth.getUser();
  user = u;
  updateAuthUI();
  if (user) await loadData();
};