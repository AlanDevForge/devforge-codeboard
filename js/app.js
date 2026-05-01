// ── FIREBASE ──
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getDatabase, ref, set, push, onValue, remove, update, serverTimestamp, onDisconnect, get}
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

// ── CONFIG ──
const firebaseConfig = {
  databaseURL: "https://codeboard-devforge-default-rtdb.europe-west1.firebasedatabase.app/"
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// ── STATE ──
let role = null;
let studentName = '';
let studentId = null;
let snippets = {};
let activeSnippetId = null;
let flags = {};
let queue = {};
let livePresenter = null; // null = instructor, else studentId
let studentEditing = false;
let connectionCount = 0;

// ── SANITISE ── strip invisible/ghost characters
function sanitise(str) {
  return str
    .replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u180E]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

// ── ROLE SELECTION ──
window.selectRole = function(r) {
  if (r === 'instructor') {
    role = 'instructor';
    enterWorkspace();
  } else {
    document.getElementById('name-group').classList.add('visible');
    document.querySelector('.login-btn-group').style.display = 'none';
    document.getElementById('student-name-input').focus();
  }
};

window.enterAsStudent = function() {
  const name = document.getElementById('student-name-input').value.trim();
  if (!name) { toast('Please enter your name', 'error'); return; }
  studentName = name;
  role = 'student';
  studentId = 'student_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  registerStudent();
  debugConnections();
  enterWorkspace();
};

document.getElementById('student-name-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') window.enterAsStudent();
});

function registerStudent() {
    console.log('registerStudent called, studentId:', studentId);
  const sRef = ref(db, 'connections/' + studentId);
  set(sRef, { name: studentName, joinedAt: serverTimestamp() });
  
  // Firebase handles cleanup server-side when connection drops
  onDisconnect(sRef).remove();
}

// DEBUG - remove after fixing
function debugConnections() {
  const connRef = ref(db, 'connections');
  onValue(connRef, snap => {
    console.log('Connections node:', snap.val());
    console.log('Connection count:', snap.size);
  });
}

// ── ENTER WORKSPACE ──
function enterWorkspace() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('workspace').classList.add('active');

  const rolePill = document.getElementById('role-pill');
  rolePill.style.display = '';
  document.getElementById('live-pill').style.display = '';

  if (role === 'instructor') {
    rolePill.textContent = 'Instructor';
    rolePill.className = 'pill pill-instructor';
    document.getElementById('instructor-toolbar').style.display = 'flex';
    document.getElementById('right-sidebar').style.display = 'flex';
    document.getElementById('connection-display').style.display = 'flex';
    document.getElementById('no-snippet-msg').style.display = 'none';
    document.getElementById('code-editor').style.display = 'flex';
    document.getElementById('code-editor').style.flex = '1';
    document.getElementById('code-wrapper').style.display = 'flex';
    document.getElementById('code-wrapper').style.flexDirection = 'column';

    // Hide placeholder as soon as instructor starts typing
    document.getElementById('code-editor').addEventListener('input', () => {
      const hasContent = document.getElementById('code-editor').value.trim().length > 0;
      document.getElementById('no-snippet-msg').style.display = 'none';
    });

    // Focus editor
    setTimeout(() => document.getElementById('code-editor').focus(), 100);
  } else {
    rolePill.textContent = studentName;
    rolePill.className = 'pill pill-student';
    document.getElementById('student-view-toolbar').style.display = 'flex';
    document.getElementById('student-right-sidebar').style.display = 'flex';
    document.getElementById('no-snippet-msg').style.display = 'flex';
  }

  subscribeToAll();
}

// ── FIREBASE SUBSCRIPTIONS ──
function subscribeToAll() {
  // Snippets
  onValue(ref(db, 'snippets'), snap => {
    snippets = snap.val() || {};
    renderSnippetList();
    // Show latest snippet to students if in instructor-presenting mode
    if (livePresenter === null || livePresenter === 'instructor') {
      const ids = Object.keys(snippets).sort((a,b) => (snippets[a].ts||0)-(snippets[b].ts||0));
      if (ids.length > 0) {
        const latestId = ids[ids.length-1];
        if (role === 'student' && !studentEditing) {
          showSnippet(latestId);
        }
        if (role === 'instructor' && !activeSnippetId) {
          setActiveSnippet(latestId);
        }
      }
    }
    updateStatusBar();
  });

  // Live presenter
  onValue(ref(db, 'livePresenter'), snap => {
    const val = snap.val();
    livePresenter = val ? val.id : null;
    handlePresenterChange();
  });

  // Flags (instructor only)
  if (role === 'instructor') {
    console.log('Setting up instructor listeners');
    onValue(ref(db, 'flags'), snap => {
      flags = snap.val() || {};
      renderFlags();
      updateStatusBar();
    });
    onValue(ref(db, 'queue'), snap => {
      queue = snap.val() || {};
      renderQueue();
    });
    onValue(ref(db, 'connections'), snap => {
        console.log('Connections raw snap exists:', snap.exists());
        console.log('Connections raw snap val:', snap.val());
        console.log('Connections size:', snap.size);
      const conns = snap.val() || {};
      console.log('Conns object keys:', Object.keys(conns));
      connectionCount = Object.keys(conns).length;
      console.log('Connection count calculated:', connectionCount);
      document.getElementById('connection-text').textContent =
        connectionCount + ' student' + (connectionCount !== 1 ? 's' : '') + ' connected';
      updateStatusBar();
    });
  }

  // Students: watch live presenter's code
  if (role === 'student') {
    onValue(ref(db, 'liveCode'), snap => {
      const val = snap.val();
      if (!val || studentEditing) return;
      if (livePresenter && livePresenter !== 'instructor') {
        // Show student presenter's code
        showLiveCode(val.code, val.language, val.name, val.presenterName);
      }
    });
  }

  // Status connected
  document.getElementById('status-dot').style.background = 'var(--green)';
  document.getElementById('status-conn-text').textContent = role === 'instructor' ? 'Session live' : 'Connected';
  document.getElementById('status-session').textContent = 'devforge-codeboard';
}

// ── SNIPPET LIST ──
function renderSnippetList() {
  const list = document.getElementById('snippet-list');
  const ids = Object.keys(snippets).sort((a,b) => (snippets[a].ts||0)-(snippets[b].ts||0));
  if (ids.length === 0) {
    list.innerHTML = '<div class="empty-list">No snippets yet</div>';
    return;
  }
  list.innerHTML = ids.map(id => {
    const s = snippets[id];
    const isActive = id === activeSnippetId;
    const whoClass = s.author === 'instructor' ? 'sn-who-instructor' : 'sn-who-student';
    const whoLabel = s.author === 'instructor' ? 'You' : s.authorName || 'Student';
    return `<div class="snippet-item ${isActive ? 'active' : ''}" onclick="selectSnippet('${id}')">
      <div class="sn-name">${escHtml(s.name || 'Untitled')}</div>
      <div class="sn-meta">
        <span class="sn-lang-tag">${escHtml(s.language || 'text')}</span>
        <span class="sn-who-tag ${whoClass}">${escHtml(whoLabel)}</span>
      </div>
    </div>`;
  }).join('');
}

window.selectSnippet = function(id) {
  if (role === 'student' && studentEditing) return;
  setActiveSnippet(id);
  showSnippet(id);
  // Show back to live button for students viewing history
  if (role === 'student') {
    document.getElementById('btn-back-live').style.display = '';
  }
};

function setActiveSnippet(id) {
  activeSnippetId = id;
  renderSnippetList();
}

function showSnippet(id) {
  const s = snippets[id];
  if (!s) return;
  setActiveSnippet(id);

  if (role === 'instructor') {
    document.getElementById('code-editor').value = s.code || '';
    document.getElementById('snippet-name-input').value = s.name || '';
    const langSel = document.getElementById('lang-select');
    langSel.value = s.language || 'auto';
    document.getElementById('no-snippet-msg').style.display = 'none';
    document.getElementById('code-editor').style.display = 'block';
  } else {
    showLiveCode(s.code, s.language, s.name, null);
  }
  updateStatusBar();
}

function showLiveCode(code, language, name, presenterName) {
  if (studentEditing) return;
  document.getElementById('no-snippet-msg').style.display = 'none';
  document.getElementById('code-display-wrap').style.display = 'block';

  const inner = document.getElementById('code-display-inner');
  const safeCode = sanitise(code || '');
  const lang = (language && language !== 'auto') ? language : null;

  if (lang) {
    try {
      inner.innerHTML = hljs.highlight(safeCode, {language: lang, ignoreIllegals: true}).value;
      inner.className = 'hljs language-' + lang;
    } catch(e) {
      inner.textContent = safeCode;
      inner.className = '';
    }
  } else {
    const result = hljs.highlightAuto(safeCode);
    inner.innerHTML = result.value;
    inner.className = 'hljs language-' + result.language;
  }

  const label = document.getElementById('viewing-label');
  const langSpan = document.getElementById('viewing-lang');
  if (presenterName) {
    label.textContent = presenterName + ' is presenting: ' + (name || 'Untitled');
    label.style.color = '#bb99ff';
  } else {
    label.textContent = name || 'Untitled';
    label.style.color = 'var(--forge-orange)';
  }
  langSpan.textContent = language && language !== 'auto' ? language : '';

  document.getElementById('btn-edit-copy').style.display = '';
}

// ── INSTRUCTOR: PUBLISH ──
window.publishSnippet = async function() {
  const code = sanitise(document.getElementById('code-editor').value);
  if (!code.trim()) { toast('Nothing to publish', 'error'); return; }

  let language = document.getElementById('lang-select').value;
  let detectedLang = language;
  if (language === 'auto') {
    const result = hljs.highlightAuto(code);
    detectedLang = result.language || 'plaintext';
    document.getElementById('lang-select').value = detectedLang;
  }

  const name = document.getElementById('snippet-name-input').value.trim() || 'Snippet ' + (Object.keys(snippets).length + 1);
  const snippetData = {
    code,
    language: detectedLang,
    name,
    author: 'instructor',
    ts: Date.now()
  };

  const newRef = push(ref(db, 'snippets'));
  await set(newRef, snippetData);

  // Set as live presenter = instructor
  await set(ref(db, 'livePresenter'), { id: 'instructor' });
  await set(ref(db, 'liveCode'), { code, language: detectedLang, name, presenterName: 'Instructor' });

  activeSnippetId = newRef.key;
  renderSnippetList();

  const btn = document.getElementById('publish-btn');
  btn.textContent = '✓ Published!';
  btn.style.background = 'var(--green)';
  btn.style.color = '#111';
  setTimeout(() => {
    btn.textContent = 'Publish to Students';
    btn.style.background = '';
    btn.style.color = '';
  }, 2000);

  toast('Snippet published to students', 'success');
};

window.clearEditor = function() {
  document.getElementById('code-editor').value = '';
  document.getElementById('snippet-name-input').value = '';
  document.getElementById('lang-select').value = 'auto';
};

// ── AUTO-DETECT ON PASTE (instructor) ──
window.handlePaste = function(e) {
  setTimeout(() => {
    const code = sanitise(document.getElementById('code-editor').value);
    const langSel = document.getElementById('lang-select');
    if (langSel.value === 'auto' || langSel.value === '') {
      const result = hljs.highlightAuto(code);
      if (result.language) {
        langSel.value = result.language;
        toast('Language detected: ' + result.language, 'info');
      }
    }
  }, 50);
};

window.onLangChange = function() {};

// ── STUDENT: EDIT & PRESENT ──
window.startStudentEdit = function(mode) {
  studentEditing = true;
  document.getElementById('student-editor-toolbar').classList.add('visible');
  document.getElementById('student-view-toolbar').style.display = 'none';
  document.getElementById('code-display-wrap').style.display = 'none';
  document.getElementById('student-editor').style.display = 'block';
  document.getElementById('no-snippet-msg').style.display = 'none';

  if (mode === 'copy' && activeSnippetId && snippets[activeSnippetId]) {
    const s = snippets[activeSnippetId];
    document.getElementById('student-editor').value = s.code || '';
    document.getElementById('student-snippet-name').value = 'Copy of ' + (s.name || 'snippet');
    document.getElementById('student-lang-select').value = s.language || 'auto';
  } else {
    document.getElementById('student-editor').value = '';
    document.getElementById('student-snippet-name').value = '';
    document.getElementById('student-lang-select').value = 'auto';
  }
  document.getElementById('student-editor').focus();
};

window.cancelStudentEdit = function() {
  studentEditing = false;
  document.getElementById('student-editor-toolbar').classList.remove('visible');
  document.getElementById('student-view-toolbar').style.display = 'flex';
  document.getElementById('student-editor').style.display = 'none';

  if (activeSnippetId && snippets[activeSnippetId]) {
    showSnippet(activeSnippetId);
  } else {
    document.getElementById('no-snippet-msg').style.display = 'flex';
  }

  // Remove from queue if pending
  if (queue[studentId]) {
    remove(ref(db, 'queue/' + studentId));
  }
  updatePresentStatus('idle');
};

window.requestPresent = async function() {
  const code = sanitise(document.getElementById('student-editor').value);
  if (!code.trim()) { toast('Write some code first', 'error'); return; }

  let language = document.getElementById('student-lang-select').value;
  if (language === 'auto') {
    const result = hljs.highlightAuto(code);
    language = result.language || 'plaintext';
    document.getElementById('student-lang-select').value = language;
  }

  const name = document.getElementById('student-snippet-name').value.trim() || studentName + "'s snippet";

  // Add to queue
  await set(ref(db, 'queue/' + studentId), {
    studentId,
    name: studentName,
    snippetName: name,
    code,
    language,
    ts: Date.now()
  });

  toast('Request sent to instructor for approval', 'info');
  updatePresentStatus('queued');
};

function updatePresentStatus(state) {
  const el = document.getElementById('present-status');
  const banner = document.getElementById('presenting-banner');
  if (state === 'idle') {
    el.textContent = 'Not presenting';
    el.style.color = 'var(--text-muted)';
    banner.classList.remove('visible');
    document.getElementById('role-pill').className = 'pill pill-student';
    document.getElementById('role-pill').textContent = studentName;
  } else if (state === 'queued') {
    el.textContent = 'Waiting for instructor approval...';
    el.style.color = '#bb99ff';
    banner.classList.remove('visible');
  } else if (state === 'presenting') {
    el.textContent = 'Presenting to the class';
    el.style.color = 'var(--green)';
    banner.classList.add('visible');
    document.getElementById('role-pill').className = 'pill pill-presenting';
    document.getElementById('role-pill').textContent = '⬡ Presenting';
  }
}

// ── INSTRUCTOR: APPROVE PRESENT ──
window.approvePresent = async function(sid) {
  const qItem = queue[sid];
  if (!qItem) return;

  const code = sanitise(qItem.code);
  const language = qItem.language;
  const name = qItem.snippetName;
  const presenterName = qItem.name;

  // Save as snippet
  const newRef = push(ref(db, 'snippets'));
  await set(newRef, {
    code, language, name,
    author: 'student',
    authorName: presenterName,
    ts: Date.now()
  });

  // Set live
  await set(ref(db, 'livePresenter'), { id: sid, name: presenterName });
  await set(ref(db, 'liveCode'), { code, language, name, presenterName });

  // Remove from queue
  await remove(ref(db, 'queue/' + sid));
  // Notify student (via livePresenter change)
  toast(presenterName + ' is now presenting to the class', 'success');

  document.getElementById('reclaim-btn').style.display = '';
};

window.denyPresent = async function(sid) {
  await remove(ref(db, 'queue/' + sid));
  toast('Presentation request declined', 'info');
};

window.reclaimBoard = async function() {
  await set(ref(db, 'livePresenter'), { id: 'instructor' });
  // Show last instructor snippet
  const ids = Object.keys(snippets)
    .filter(id => snippets[id].author === 'instructor')
    .sort((a,b) => (snippets[a].ts||0)-(snippets[b].ts||0));
  if (ids.length > 0) {
    const latest = snippets[ids[ids.length-1]];
    await set(ref(db, 'liveCode'), {
      code: latest.code,
      language: latest.language,
      name: latest.name,
      presenterName: 'Instructor'
    });
  }
  document.getElementById('reclaim-btn').style.display = 'none';
  toast('Board reclaimed', 'success');
};

// ── PRESENTER CHANGE HANDLER ──
function handlePresenterChange() {
  if (role === 'instructor') {
    if (livePresenter && livePresenter !== 'instructor') {
      document.getElementById('reclaim-btn').style.display = '';
    }
  }
  if (role === 'student') {
    if (livePresenter === studentId) {
      updatePresentStatus('presenting');
    } else if (livePresenter && livePresenter !== 'instructor') {
      // Someone else presenting — show their code via liveCode subscription
    }
  }
}

// ── FLAGS ──
window.raiseFlag = async function() {
  const msg = document.getElementById('flag-message').value.trim();
  await set(ref(db, 'flags/' + studentId), {
    name: studentName,
    message: msg,
    ts: Date.now()
  });
  document.getElementById('flag-message').value = '';
  toast('Flag raised — your instructor has been notified', 'success');
};

function renderFlags() {
  const list = document.getElementById('flags-list');
  const ids = Object.keys(flags).sort((a,b) => (flags[a].ts||0)-(flags[b].ts||0));
  const btn = document.getElementById('clear-flags-btn');

  if (ids.length === 0) {
    list.innerHTML = '<div class="empty-list" id="flags-empty">No flags raised</div>';
    btn.style.display = 'none';
    return;
  }

  btn.style.display = '';
  list.innerHTML = ids.map(id => {
    const f = flags[id];
    const time = timeAgo(f.ts);
    return `<div class="flag-item">
      <div class="flag-name">⚑ ${escHtml(f.name)}</div>
      ${f.message ? `<div class="flag-msg">${escHtml(f.message)}</div>` : ''}
      <div class="flag-time">${time}</div>
      <div class="flag-actions">
        <button class="btn btn-danger btn-sm" onclick="dismissFlag('${id}')">Dismiss</button>
      </div>
    </div>`;
  }).join('');
}

window.dismissFlag = function(id) {
  remove(ref(db, 'flags/' + id));
};

window.clearAllFlags = function() {
  remove(ref(db, 'flags'));
};

window.clearSnippets = function() {
  showModal(
    'Clear Snippet History',
    'This will remove all published snippets for all students. Are you sure?',
    [
      { label: 'Cancel', action: closeModal, style: 'btn-ghost' },
      { label: 'Clear Snippets', action: async () => {
          await remove(ref(db, 'snippets'));
          await remove(ref(db, 'liveCode'));
          await set(ref(db, 'livePresenter'), { id: 'instructor' });
          activeSnippetId = null;
          document.getElementById('code-editor').value = '';
          document.getElementById('snippet-name-input').value = '';
          document.getElementById('lang-select').value = 'auto';
          document.getElementById('no-snippet-msg').style.display = 'flex';
          document.getElementById('code-editor').style.display = 'block';
          closeModal();
          toast('Snippet history cleared', 'success');
        }, style: 'btn-danger'
      }
    ]
  );
};

window.clearSession = function() {
  showModal(
    'Clear Entire Session',
    'This will remove all snippets, flags, and the present queue for everyone. Are you sure?',
    [
      { label: 'Cancel', action: closeModal, style: 'btn-ghost' },
      { label: 'Clear Everything', action: async () => {
          await remove(ref(db, 'snippets'));
          await remove(ref(db, 'liveCode'));
          await remove(ref(db, 'flags'));
          await remove(ref(db, 'queue'));
          await set(ref(db, 'livePresenter'), { id: 'instructor' });
          activeSnippetId = null;
          document.getElementById('code-editor').value = '';
          document.getElementById('snippet-name-input').value = '';
          document.getElementById('lang-select').value = 'auto';
          document.getElementById('no-snippet-msg').style.display = 'flex';
          document.getElementById('code-editor').style.display = 'block';
          closeModal();
          toast('Session cleared', 'success');
        }, style: 'btn-danger'
      }
    ]
  );
};

function showModal(title, body, buttons) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  const actions = document.getElementById('modal-actions');
  actions.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + b.style;
    btn.textContent = b.label;
    btn.onclick = b.action;
    actions.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.add('visible');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('visible');
}

// ── PRESENT QUEUE ──
function renderQueue() {
  const list = document.getElementById('queue-list');
  const ids = Object.keys(queue).sort((a,b) => (queue[a].ts||0)-(queue[b].ts||0));

  if (ids.length === 0) {
    list.innerHTML = '<div class="empty-list" id="queue-empty">No students queued</div>';
    return;
  }

  list.innerHTML = ids.map(id => {
    const q = queue[id];
    return `<div class="queue-item">
      <div class="queue-name">⬡ ${escHtml(q.name)}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">"${escHtml(q.snippetName || 'Untitled')}"</div>
      <div class="queue-actions">
        <button class="btn btn-success btn-sm" onclick="approvePresent('${id}')">Approve</button>
        <button class="btn btn-danger btn-sm" onclick="denyPresent('${id}')">Decline</button>
      </div>
    </div>`;
  }).join('');
}

// ── COPY CODE ──
window.copyCode = function() {
  const code = document.getElementById('code-display-inner').textContent;
  navigator.clipboard.writeText(sanitise(code)).then(() => {
    const btn = document.getElementById('copy-btn');
    btn.textContent = '✓ Copied!';
    btn.style.color = 'var(--green)';
    btn.style.borderColor = 'var(--green)';
    setTimeout(() => {
      btn.textContent = 'Copy';
      btn.style.color = '';
      btn.style.borderColor = '';
    }, 2000);
  });
};

// ── STUDENT PASTE AUTO-DETECT ──
window.handleStudentPaste = function(e) {
  setTimeout(() => {
    const code = sanitise(document.getElementById('student-editor').value);
    const sel = document.getElementById('student-lang-select');
    if (sel.value === 'auto') {
      const result = hljs.highlightAuto(code);
      if (result.language) {
        sel.value = result.language;
        toast('Language detected: ' + result.language, 'info');
      }
    }
  }, 50);
};

// ── STATUS BAR ──
function updateStatusBar() {
  const count = Object.keys(snippets).length;
  document.getElementById('status-snippets').textContent =
    count > 0 ? count + ' snippet' + (count !== 1 ? 's' : '') : '';

  if (role === 'instructor') {
    const flagCount = Object.keys(flags).length;
    document.getElementById('status-flags').textContent =
      flagCount > 0 ? '⚑ ' + flagCount + ' flag' + (flagCount !== 1 ? 's' : '') : '';
  }
}

// ── UTILS ──
function escHtml(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return Math.floor(diff/60) + ' min ago';
  return Math.floor(diff/3600) + ' hr ago';
}

window.toast = function(msg, type='info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
};

// Tab key in editors
document.getElementById('code-editor').addEventListener('keydown', handleTab);
document.getElementById('student-editor').addEventListener('keydown', handleTab);
function handleTab(e) {
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta = e.target;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    ta.value = ta.value.slice(0,start) + '  ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 2;
  }
}

window.backToLive = function() {
  // Read current liveCode from Firebase and display it
  import('https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js')
    .then(({ get }) => get(ref(db, 'liveCode')))
    .then(snap => {
      const val = snap.val();
      if (!val) { toast('No live code at the moment', 'info'); return; }
      showLiveCode(val.code, val.language, val.name, val.presenterName !== 'Instructor' ? val.presenterName : null);
      document.getElementById('btn-back-live').style.display = 'none';
    });
};

console.log('app.js loaded successfully');