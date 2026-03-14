const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3456;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// --- Live sessions ---

function getClaudeSessions() {
  try {
    const pids = execSync("pgrep -x claude 2>/dev/null || true", { encoding: 'utf8' }).trim();
    if (!pids) return [];

    return pids.split('\n').filter(Boolean).map(pid => {
      try {
        const info = execSync(`ps -o pid=,tty=,%cpu=,%mem=,etime=,state= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim();
        if (!info) return null;
        const [pidStr, tty, cpu, mem, elapsed, state] = info.split(/\s+/);

        let cwd = '';
        try { cwd = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep '^n/' | head -1`, { encoding: 'utf8' }).trim().replace(/^n/, ''); } catch {}
        if (!cwd) try { cwd = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, { encoding: 'utf8' }).trim(); } catch {}

        const cpuNum = parseFloat(cpu);
        let status = 'idle';
        if (cpuNum > 15) status = 'working';
        else if (cpuNum > 5) status = 'thinking';

        // Get recent messages from session file
        const messages = getSessionMessages(cwd);

        return {
          pid: pidStr, tty, cpu: `${cpu}%`, mem: `${mem}%`, elapsed, cwd,
          projectName: cwd ? path.basename(cwd) : 'unknown',
          status,
          messages,
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

function getSessionMessages(cwd, count = 8) {
  if (!cwd) return [];
  const projKey = cwd.replace(/\//g, '-');
  const projDir = path.join(PROJECTS_DIR, projKey);
  try {
    if (!fs.existsSync(projDir)) return [];
    const files = fs.readdirSync(projDir)
      .filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(projDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return [];

    const filePath = path.join(projDir, files[0].name);
    const stat = fs.statSync(filePath);
    // Read last 64KB to get enough messages
    const readSize = Math.min(stat.size, 65536);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
    fs.closeSync(fd);

    const msgs = [];
    for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
      try {
        const d = JSON.parse(line);
        const role = d.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const content = d.message.content;
        let text = '';
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          for (const c of content) {
            if (c.type === 'text' && c.text?.trim()) { text = c.text.trim(); break; }
          }
        }
        if (text) msgs.push({ role, text: text.slice(0, 300) });
      } catch {}
    }
    return msgs.slice(-count);
  } catch { return []; }
}

// --- Recent sessions ---

function getRecentSessions(limit = 20) {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const sessions = [];
    for (const projDir of fs.readdirSync(PROJECTS_DIR)) {
      const projPath = path.join(PROJECTS_DIR, projDir);
      if (!fs.statSync(projPath).isDirectory()) continue;
      for (const file of fs.readdirSync(projPath).filter(f => f.endsWith('.jsonl') && !f.includes('subagent'))) {
        const filePath = path.join(projPath, file);
        const stat = fs.statSync(filePath);
        let projectName = projDir.replace(/-Users-[^-]+-Documents-/, '').replace(/-Users-[^-]+-Downloads-?/, '~/Downloads/').replace(/-Users-[^-]+-/, '~/').replace(/^-Users-[^-]+$/, '~');
        let firstMessage = '';
        try {
          const fd = fs.openSync(filePath, 'r');
          const buf = Buffer.alloc(8192);
          const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
          fs.closeSync(fd);
          for (const line of buf.toString('utf8', 0, bytesRead).split('\n').filter(Boolean)) {
            try {
              const d = JSON.parse(line);
              if (d.type === 'user' && d.message?.role === 'user') {
                const content = d.message.content;
                if (typeof content === 'string') firstMessage = content.slice(0, 120);
                else if (Array.isArray(content)) { for (const c of content) { if (c.type === 'text') { firstMessage = c.text.slice(0, 120); break; } } }
                break;
              }
            } catch {}
          }
        } catch {}
        sessions.push({
          sessionId: path.basename(file, '.jsonl'), projectName, cwd: projDir.replace(/-/g, '/'),
          lastModified: stat.mtimeMs, lastModifiedStr: formatTimeAgo(stat.mtime), firstMessage: firstMessage || '(no message)',
        });
      }
    }
    return sessions.sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
  } catch { return []; }
}

function formatTimeAgo(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// --- SSE ---
const sseClients = new Set();
setInterval(() => {
  const data = JSON.stringify({ live: getClaudeSessions(), recent: getRecentSessions() });
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`); } catch { sseClients.delete(res); }
  }
}, 2000);

// --- HTML ---
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>See Claude</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: #0a0a0a;
    color: #e0e0e0;
    font-family: 'JetBrains Mono', monospace;
    min-height: 100vh;
  }

  .container {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100vh;
    padding: 30px 40px;
    max-width: 1400px;
    margin: 0 auto;
  }

  .header { text-align: center; margin-bottom: 24px; }
  .header h1 { font-size: 14px; font-weight: 300; color: #555; letter-spacing: 4px; text-transform: uppercase; }
  .header .count { font-size: 48px; font-weight: 700; color: #fff; margin: 5px 0; }
  .header .subtitle { font-size: 12px; color: #444; letter-spacing: 2px; }

  .live-dot {
    display: inline-block; width: 6px; height: 6px; background: #27c93f;
    border-radius: 50%; margin-right: 6px; animation: pulse 2s ease-in-out infinite;
  }
  .live-badge {
    display: inline-block; font-size: 9px; color: #27c93f;
    border: 1px solid #27c93f33; padding: 2px 8px; border-radius: 10px; margin-left: 8px; letter-spacing: 1px;
  }

  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .section-title {
    font-size: 11px; font-weight: 300; color: #444; letter-spacing: 3px;
    text-transform: uppercase; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #1a1a1a;
  }

  #live-section { width: 100%; }

  .grid {
    display: flex; flex-wrap: wrap; justify-content: center;
    gap: 20px; margin-bottom: 40px; width: 100%;
  }

  /* --- Station card --- */
  .station {
    width: 260px; cursor: pointer; transition: transform 0.2s; position: relative;
  }
  .station:hover { transform: translateY(-3px); }
  .station.expanded {
    width: 500px; cursor: default;
  }
  .station.expanded:hover { transform: none; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  .station.entering { animation: fadeIn 0.3s ease forwards; }

  .monitor {
    background: #111; border: 1px solid #222; border-radius: 8px;
    padding: 12px; position: relative; overflow: hidden;
  }
  .monitor::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px;
    background: linear-gradient(90deg, transparent, #333, transparent);
  }

  .station.working .monitor { border-color: #27c93f22; }
  .station.thinking .monitor { border-color: #ffbd2e22; }

  .screen {
    background: #0d1117; border: 1px solid #1a1a2e; border-radius: 4px;
    padding: 10px; position: relative;
  }

  .screen-header {
    display: flex; align-items: center; gap: 6px;
    margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid #1a1a2e;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; }
  .dot.red { background: #ff5f56; }
  .dot.yellow { background: #ffbd2e; }
  .dot.green { background: #27c93f; }
  .screen-status {
    font-size: 9px; margin-left: auto; text-transform: uppercase; letter-spacing: 1px;
  }

  .project-name { font-size: 14px; font-weight: 500; color: #e0e0e0; margin-bottom: 2px; }
  .project-path { font-size: 9px; color: #393939; word-break: break-all; margin-bottom: 6px; }

  /* Last message preview (collapsed) */
  .last-msg-preview {
    font-size: 11px; color: #888; margin: 6px 0; line-height: 1.5;
    max-height: 52px; overflow: hidden; display: -webkit-box;
    -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  }
  .msg-label {
    font-size: 8px; text-transform: uppercase; letter-spacing: 1px; margin-right: 4px;
  }
  .msg-label.claude { color: #cc7832; }
  .msg-label.you { color: #6a9eff; }

  .stats {
    display: flex; gap: 10px; margin-top: 6px; font-size: 9px; color: #444;
    padding-top: 6px; border-top: 1px solid #1a1a2e;
  }
  .stat-label { color: #333; }
  .stat-value { color: #555; }

  .stand { width: 40px; height: 10px; background: #181818; margin: 0 auto; border-radius: 0 0 4px 4px; }
  .base { width: 60px; height: 3px; background: #181818; margin: 0 auto; border-radius: 2px; }

  /* --- Expanded view --- */
  .expanded-content { display: none; }
  .station.expanded .expanded-content { display: block; }
  .station.expanded .last-msg-preview { display: none; }
  .station.expanded .stand, .station.expanded .base { display: none; }

  .msg-history {
    margin: 8px 0; max-height: 300px; overflow-y: auto;
    scrollbar-width: thin; scrollbar-color: #333 transparent;
  }
  .msg-history::-webkit-scrollbar { width: 4px; }
  .msg-history::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }

  .msg-bubble {
    margin-bottom: 8px; font-size: 11px; line-height: 1.5;
  }
  .msg-bubble .msg-role {
    font-size: 8px; text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: 2px; display: block;
  }
  .msg-bubble .msg-text {
    color: #999; padding: 6px 8px; background: #0a0e14; border-radius: 4px;
    white-space: pre-wrap; word-break: break-word;
  }
  .msg-bubble.assistant .msg-role { color: #cc7832; }
  .msg-bubble.user .msg-role { color: #6a9eff; }
  .msg-bubble.user .msg-text { background: #0d1220; color: #8ab4f8; }

  .expanded-actions {
    display: flex; gap: 6px; margin-top: 8px; align-items: center;
  }

  .chat-input {
    flex: 1; background: #0d1117; border: 1px solid #2a2a3e; color: #e0e0e0;
    font-family: 'JetBrains Mono', monospace; font-size: 11px;
    padding: 8px 10px; border-radius: 4px; outline: none;
  }
  .chat-input:focus { border-color: #cc7832; }
  .chat-input::placeholder { color: #333; }

  .btn {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    padding: 8px 12px; border-radius: 4px; cursor: pointer;
    transition: all 0.2s; border: 1px solid; white-space: nowrap;
  }
  .btn-send {
    background: #1a1a2e; border-color: #2a2a3e; color: #cc7832;
  }
  .btn-send:hover { background: #2a2a3e; border-color: #cc7832; }
  .btn-terminal {
    background: #1a2e1a; border-color: #2a3e2a; color: #6a6;
  }
  .btn-terminal:hover { background: #2a3e2a; border-color: #27c93f; color: #27c93f; }
  .btn-close {
    background: transparent; border-color: #222; color: #444;
  }
  .btn-close:hover { border-color: #444; color: #888; }

  .sent-flash {
    font-size: 9px; color: #27c93f; margin-left: 8px;
    opacity: 0; transition: opacity 0.3s;
  }
  .sent-flash.visible { opacity: 1; }

  /* --- Mode toggle --- */
  .mode-toggle { display: flex; justify-content: center; gap: 0; margin-bottom: 24px; }
  .mode-btn {
    background: #111; border: 1px solid #222; color: #444;
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    padding: 6px 20px; cursor: pointer; transition: all 0.2s;
    letter-spacing: 2px; text-transform: uppercase;
  }
  .mode-btn:first-child { border-radius: 4px 0 0 4px; }
  .mode-btn:last-child { border-radius: 0 4px 4px 0; border-left: none; }
  .mode-btn.active { background: #1a1a2e; color: #cc7832; border-color: #cc783244; }
  .mode-btn:hover:not(.active) { color: #888; }

  /* --- Advanced panel --- */
  .skip-perms { display: flex; align-items: center; gap: 8px; padding: 10px 16px; margin-bottom: 12px; }
  .toggle-switch { position: relative; width: 32px; height: 18px; cursor: pointer; }
  .toggle-switch input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    background: #222; border-radius: 9px; transition: 0.2s;
  }
  .toggle-slider::before {
    content: ''; position: absolute; width: 14px; height: 14px;
    left: 2px; bottom: 2px; background: #555; border-radius: 50%; transition: 0.2s;
  }
  .toggle-switch input:checked + .toggle-slider { background: #cc783244; }
  .toggle-switch input:checked + .toggle-slider::before { transform: translateX(14px); background: #cc7832; }
  .skip-perms-label { font-size: 10px; color: #555; cursor: pointer; }
  .skip-perms-warn { font-size: 9px; color: #cc783266; margin-left: 4px; }

  .recent-section { margin-top: auto; padding-top: 20px; width: 100%; }
  .recent-table { width: 100%; border-collapse: collapse; }
  .recent-table th {
    font-size: 9px; font-weight: 400; color: #444; text-transform: uppercase;
    letter-spacing: 2px; text-align: left; padding: 8px 12px; border-bottom: 1px solid #1a1a1a;
  }
  .recent-table td {
    font-size: 12px; padding: 10px 12px; border-bottom: 1px solid #111; color: #666; vertical-align: top;
  }
  .recent-row { cursor: pointer; transition: background 0.15s; }
  .recent-row:hover { background: #111; }
  .recent-row:hover td { color: #999; }
  .recent-project { color: #aaa; font-weight: 500; }
  .recent-message { color: #555; font-size: 11px; max-width: 500px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recent-time { color: #444; font-size: 11px; white-space: nowrap; }
  .btn-group { display: flex; gap: 4px; }

  .resume-btn, .launch-btn {
    font-family: 'JetBrains Mono', monospace; font-size: 10px;
    padding: 4px 10px; border-radius: 4px; cursor: pointer; transition: all 0.2s; white-space: nowrap;
  }
  .resume-btn { background: #1a1a2e; border: 1px solid #2a2a3e; color: #888; }
  .resume-btn:hover { background: #2a2a3e; color: #cc7832; border-color: #cc7832; }
  .launch-btn { background: #1a2e1a; border: 1px solid #2a3e2a; color: #6a6; margin-left: 4px; }
  .launch-btn:hover { background: #2a3e2a; color: #27c93f; border-color: #27c93f; }

  .copy-toast {
    position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%) translateY(20px);
    background: #1a1a2e; border: 1px solid #cc7832; color: #cc7832;
    padding: 8px 20px; border-radius: 6px; font-size: 12px;
    font-family: 'JetBrains Mono', monospace; opacity: 0;
    transition: all 0.3s ease; pointer-events: none; z-index: 100;
  }
  .copy-toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }

  .footer { text-align: center; padding: 20px; font-size: 10px; color: #222; }
</style>
</head>
<body>

<div class="container">
  <div class="header">
    <h1>See Claude</h1>
    <div class="count" id="count">-</div>
    <div class="subtitle"><span class="live-dot"></span>active sessions <span class="live-badge">LIVE</span></div>
  </div>

  <div id="live-section">
    <div class="section-title">Running Now</div>
    <div class="grid" id="grid"></div>
  </div>

  <div class="mode-toggle">
    <button class="mode-btn active" id="btn-simple" onclick="setMode('simple')">simple</button>
    <button class="mode-btn" id="btn-advanced" onclick="setMode('advanced')">advanced</button>
  </div>

  <div id="advanced-panel" style="display:none">
    <div class="skip-perms">
      <label class="toggle-switch">
        <input type="checkbox" id="skip-perms-toggle">
        <span class="toggle-slider"></span>
      </label>
      <label class="skip-perms-label" for="skip-perms-toggle">--dangerously-skip-permissions</label>
      <span class="skip-perms-warn">bypasses all permission checks</span>
    </div>
    <div class="recent-section">
      <div class="section-title">Recent Sessions</div>
      <table class="recent-table">
        <thead><tr><th>Project</th><th>First Message</th><th>Last Active</th><th></th></tr></thead>
        <tbody id="recent-body"></tbody>
      </table>
    </div>
  </div>

  <div class="footer">auto-updates via server-sent events</div>
</div>

<div class="copy-toast" id="toast">Copied</div>

<script>
let previousPids = new Set();
let expandedPid = null;

function getStatusLabel(s) { return s === 'working' ? 'Working' : s === 'thinking' ? 'Thinking' : 'Idle'; }
function getStatusColor(s) { return s === 'working' ? '#27c93f' : s === 'thinking' ? '#ffbd2e' : '#555'; }

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function renderLive(sessions) {
  const grid = document.getElementById('grid');
  document.getElementById('count').textContent = sessions.length;

  if (!sessions.length) {
    grid.innerHTML = '<div style="color:#333;font-size:13px;padding:30px;text-align:center">No Claude sessions running</div>';
    previousPids = new Set();
    return;
  }

  const currentPids = new Set(sessions.map(s => s.pid));
  const newPids = sessions.filter(s => !previousPids.has(s.pid)).map(s => s.pid);

  grid.innerHTML = sessions.map(s => {
    const isNew = newPids.includes(s.pid);
    const isExpanded = expandedPid === s.pid;
    const lastMsg = s.messages?.length ? s.messages[s.messages.length - 1] : null;

    // Build message history for expanded view
    let msgHtml = '';
    if (s.messages?.length) {
      msgHtml = s.messages.map(m => \`
        <div class="msg-bubble \${m.role}">
          <span class="msg-role">\${m.role === 'assistant' ? 'Claude' : 'You'}</span>
          <div class="msg-text">\${escapeHtml(m.text)}</div>
        </div>
      \`).join('');
    }

    return \`
    <div class="station \${s.status} \${isNew ? 'entering' : ''} \${isExpanded ? 'expanded' : ''}" data-pid="\${s.pid}" onclick="handleClick('\${s.pid}', '\${s.tty}', event)">
      <div class="monitor">
        <div class="screen">
          <div class="screen-header">
            <div class="dot red"></div>
            <div class="dot yellow"></div>
            <div class="dot green"></div>
            <span class="screen-status" style="color:\${getStatusColor(s.status)}">\${getStatusLabel(s.status)}</span>
          </div>
          <div class="project-name">\${escapeHtml(s.projectName)}</div>
          <div class="project-path">\${escapeHtml(s.cwd)}</div>
          \${lastMsg ? \`<div class="last-msg-preview"><span class="msg-label \${lastMsg.role === 'assistant' ? 'claude' : 'you'}">\${lastMsg.role === 'assistant' ? 'Claude:' : 'You:'}</span> \${escapeHtml(lastMsg.text)}</div>\` : ''}
          <div class="expanded-content">
            <div class="msg-history" id="history-\${s.pid}">\${msgHtml}</div>
            <div class="expanded-actions">
              <input class="chat-input" id="input-\${s.pid}" placeholder="send a message..." onkeydown="if(event.key==='Enter')sendMsg('\${s.tty}','\${s.pid}',event)" onclick="event.stopPropagation()">
              <button class="btn btn-send" onclick="sendMsg('\${s.tty}','\${s.pid}',event)" onmousedown="event.preventDefault()">send</button>
              <button class="btn btn-terminal" onclick="openTerminal('\${s.tty}','\${s.pid}',event)">terminal</button>
              <button class="btn btn-close" onclick="collapseCard(event)">close</button>
              <span class="sent-flash" id="sent-\${s.pid}">sent!</span>
            </div>
          </div>
          <div class="stats">
            <span><span class="stat-label">CPU</span> <span class="stat-value">\${s.cpu}</span></span>
            <span><span class="stat-label">MEM</span> <span class="stat-value">\${s.mem}</span></span>
            <span><span class="stat-label">UP</span> <span class="stat-value">\${s.elapsed}</span></span>
          </div>
        </div>
      </div>
      <div class="stand"></div>
      <div class="base"></div>
    </div>
  \`}).join('');

  // Scroll message history to bottom for expanded card
  if (expandedPid) {
    const hist = document.getElementById('history-' + expandedPid);
    if (hist) hist.scrollTop = hist.scrollHeight;
    // Restore focus on input if it was focused
    const input = document.getElementById('input-' + expandedPid);
    if (input && document.activeElement?.tagName !== 'INPUT') {
      // Don't steal focus, but keep it if it was there
    }
  }

  previousPids = currentPids;
}

function handleClick(pid, tty, event) {
  // Don't expand if clicking inside expanded content
  if (event.target.closest('.expanded-content') || event.target.closest('.btn')) return;

  if (expandedPid === pid) {
    // Already expanded, clicking header area - go to terminal
    expandedPid = null;
  } else {
    expandedPid = pid;
  }
  // Re-render will pick up expandedPid
  if (lastData) {
    renderLive(lastData.live);
    // Scroll history and focus input
    setTimeout(() => {
      if (expandedPid) {
        const hist = document.getElementById('history-' + expandedPid);
        if (hist) hist.scrollTop = hist.scrollHeight;
        const input = document.getElementById('input-' + expandedPid);
        if (input) input.focus();
      }
    }, 50);
  }
}

function collapseCard(event) {
  event.stopPropagation();
  expandedPid = null;
  if (lastData) renderLive(lastData.live);
}

async function sendMsg(tty, pid, event) {
  event.stopPropagation();
  const input = document.getElementById('input-' + pid);
  const msg = input.value.trim();
  if (!msg) return;

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tty, message: msg }),
    });
    const data = await res.json();
    if (data.ok) {
      input.value = '';
      const sent = document.getElementById('sent-' + pid);
      sent.classList.add('visible');
      setTimeout(() => sent.classList.remove('visible'), 1500);
    } else {
      showToast('Failed to send: ' + (data.error || 'unknown'));
    }
  } catch { showToast('Failed to send'); }
}

async function openTerminal(tty, pid, event) {
  event.stopPropagation();
  try { await fetch('/api/focus?tty=' + encodeURIComponent(tty) + '&pid=' + encodeURIComponent(pid)); } catch {}
}

function renderRecent(sessions) {
  const tbody = document.getElementById('recent-body');
  if (!tbody) return;
  tbody.innerHTML = sessions.map(s => \`
    <tr class="recent-row">
      <td class="recent-project">\${escapeHtml(s.projectName)}</td>
      <td class="recent-message">\${escapeHtml(s.firstMessage)}</td>
      <td class="recent-time">\${s.lastModifiedStr}</td>
      <td><div class="btn-group">
        <button class="resume-btn" onclick="copyResume('\${s.sessionId}',event)">copy</button>
        <button class="launch-btn" onclick="launchResume('\${s.sessionId}','\${escapeHtml(s.cwd)}',event)">launch</button>
      </div></td>
    </tr>
  \`).join('');
}

function getResumeCmd(id) {
  let cmd = 'claude --resume ' + id;
  if (document.getElementById('skip-perms-toggle')?.checked) cmd += ' --dangerously-skip-permissions';
  return cmd;
}
function copyResume(id, e) {
  e.stopPropagation();
  const cmd = getResumeCmd(id);
  navigator.clipboard.writeText(cmd).then(() => showToast('Copied: ' + cmd)).catch(() => showToast('Copy failed'));
}
async function launchResume(id, cwd, e) {
  e.stopPropagation();
  const skip = document.getElementById('skip-perms-toggle')?.checked;
  try {
    const r = await fetch('/api/launch', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({sessionId:id,cwd,skipPerms:skip}) });
    const d = await r.json();
    showToast(d.ok ? 'Launched in new Terminal tab' : 'Launch failed');
  } catch { showToast('Launch failed'); }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('visible');
  setTimeout(() => t.classList.remove('visible'), 2000);
}

function setMode(mode) {
  document.getElementById('advanced-panel').style.display = mode === 'advanced' ? 'block' : 'none';
  document.getElementById('btn-advanced').classList.toggle('active', mode === 'advanced');
  document.getElementById('btn-simple').classList.toggle('active', mode === 'simple');
  localStorage.setItem('see-claude-mode', mode);
}
if (localStorage.getItem('see-claude-mode') === 'advanced') setTimeout(() => setMode('advanced'), 0);

// --- SSE ---
let lastData = null;

function connectSSE() {
  const src = new EventSource('/api/stream');
  src.onmessage = (e) => {
    try {
      lastData = JSON.parse(e.data);
      // Don't re-render if user is interacting with expanded card
      const inputFocused = expandedPid && document.activeElement?.id === 'input-' + expandedPid;
      if (!inputFocused) {
        renderLive(lastData.live);
      }
      renderRecent(lastData.recent);
    } catch {}
  };
  src.onerror = () => { src.close(); setTimeout(connectSSE, 3000); };
}

fetch('/api/sessions').then(r => r.json()).then(data => {
  lastData = data;
  renderLive(data.live);
  renderRecent(data.recent);
  connectSSE();
}).catch(connectSSE);
</script>
</body>
</html>`;

// --- Server ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ live: getClaudeSessions(), recent: getRecentSessions() }));

  } else if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('\n');
    sseClients.add(res);
    const data = JSON.stringify({ live: getClaudeSessions(), recent: getRecentSessions() });
    res.write(`data: ${data}\n\n`);
    req.on('close', () => sseClients.delete(res));

  } else if (url.pathname === '/api/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { tty, message } = JSON.parse(body);
        const ttyNum = tty.replace(/^ttys?0*/, '');

        // Write message to temp file to avoid all quoting issues
        const tmpFile = `/tmp/see-claude-msg-${Date.now()}.txt`;
        fs.writeFileSync(tmpFile, message);

        // AppleScript: find tab, type message from file, press enter
        const script = [
          'tell application "Terminal"',
          '  activate',
          '  repeat with w from 1 to count of windows',
          '    set win to window w',
          '    repeat with t from 1 to count of tabs of win',
          '      set theTab to tab t of win',
          `      if tty of theTab contains "${ttyNum}" then`,
          '        set selected tab of win to theTab',
          '        set index of win to 1',
          '        delay 0.2',
          '        tell application "System Events"',
          '          tell process "Terminal"',
          `            set msgText to (read POSIX file "${tmpFile}")`,
          '            keystroke msgText',
          '            keystroke return',
          '          end tell',
          '        end tell',
          '        return "sent"',
          '      end if',
          '    end repeat',
          '  end repeat',
          'end tell',
        ].join('\n');

        execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8', timeout: 5000 });
        try { fs.unlinkSync(tmpFile); } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/launch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { sessionId, cwd, skipPerms } = JSON.parse(body);
        let cmd = `claude --resume ${sessionId}`;
        if (skipPerms) cmd += ' --dangerously-skip-permissions';
        const dirPath = cwd.startsWith('/') ? cwd : `/${cwd}`;
        const script = `tell application "Terminal"\nactivate\ndo script "cd ${dirPath.replace(/"/g, '\\"')} && ${cmd}"\nend tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e) }));
      }
    });
    return;

  } else if (url.pathname === '/api/focus') {
    const tty = url.searchParams.get('tty');
    if (tty) {
      try {
        const ttyNum = tty.replace(/^ttys?0*/, '');
        const script = `tell application "Terminal"\nactivate\nrepeat with w from 1 to count of windows\nset win to window w\nrepeat with t from 1 to count of tabs of win\nset theTab to tab t of win\nif tty of theTab contains "${ttyNum}" then\nset selected tab of win to theTab\nset index of win to 1\nreturn "found"\nend if\nend repeat\nend repeat\nend tell`;
        execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8' });
      } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  }
});

server.listen(PORT, () => {
  console.log(`\n  See Claude running at http://localhost:${PORT}\n`);
});
