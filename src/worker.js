export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      let response;

      if (method === 'POST' && path === '/api/note') {
        const body = await request.json();
        const id = generateId();
        
        const namespace = env.NOTE_STORE;
        const stub = namespace.get(namespace.idFromName(id));
        
        response = await stub.fetch(new Request('https://do/store', {
          method: 'POST',
          body: JSON.stringify({ ...body, id }),
        }));
        
      } else if (method === 'GET' && path.startsWith('/api/note/')) {
        const id = path.replace('/api/note/', '');
        
        const namespace = env.NOTE_STORE;
        const stub = namespace.get(namespace.idFromName(id));
        
        response = await stub.fetch(new Request('https://do/retrieve'));
        
      } else if (method === 'GET' && (path === '/' || path === '/index.html' || path.startsWith('/view/'))) {
        return new Response(HTML_CONTENT, {
          headers: { 
            'Content-Type': 'text/html; charset=utf-8',
            ...corsHeaders 
          },
        });
        
      } else {
        response = new Response('Not Found', { status: 404 });
      }

      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
      
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },

  // Cron trigger handler - runs periodically to clean up old notes
  async scheduled(event, env, ctx) {
    console.log('Cron triggered: cleaning up old notes');
    
    // Get the cleanup Durable Object
    const namespace = env.NOTE_STORE;
    const stub = namespace.get(namespace.idFromName('__cleanup__'));
    
    await stub.fetch(new Request('https://do/cleanup-all'));
    
    console.log('Cleanup completed');
  },
};

function generateId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return timestamp + random;
}

export class NoteStore {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    
    this.state.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id TEXT PRIMARY KEY,
          ciphertext TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER
        )
      `);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Clean up expired notes on each request
    this.cleanupExpired();

    if (path === '/store') {
      const body = await request.json();
      const { id, ciphertext, ttl_seconds } = body;
      
      const now = Date.now();
      // If no TTL specified, default to 7 days max retention
      const maxRetention = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
      const expiresAt = ttl_seconds 
        ? now + (ttl_seconds * 1000)
        : now + maxRetention;
      
      this.sql.exec(
        `INSERT INTO notes (id, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        id, ciphertext, now, expiresAt
      );
      
      return Response.json({ id });
      
    } else if (path === '/retrieve') {
      const rows = this.sql.exec(`SELECT * FROM notes LIMIT 1`).toArray();
      
      if (rows.length === 0) {
        return Response.json({
          success: false,
          error: 'Note not found or already read',
        });
      }
      
      const note = rows[0];
      
      if (note.expires_at && Date.now() > note.expires_at) {
        this.sql.exec(`DELETE FROM notes WHERE id = ?`, note.id);
        return Response.json({
          success: false,
          error: 'Note has expired',
        });
      }
      
      // Delete the note (one-time read)
      this.sql.exec(`DELETE FROM notes WHERE id = ?`, note.id);
      
      return Response.json({
        success: true,
        ciphertext: note.ciphertext,
      });
      
    } else if (path === '/cleanup-all') {
      // Called by cron - delete all expired notes
      const now = Date.now();
      const result = this.sql.exec(
        `DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?`,
        now
      );
      console.log(`Cleanup: deleted expired notes`);
      
      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  cleanupExpired() {
    const now = Date.now();
    this.sql.exec(`DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?`, now);
  }
}

const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flashpaper - Self-Destructing Notes</title>
    <style>
        :root {
            --bg-primary: #0a0a0a;
            --bg-secondary: #141414;
            --bg-tertiary: #1a1a1a;
            --text-primary: #e0e0e0;
            --text-secondary: #888;
            --accent: #ff6b35;
            --accent-dim: #cc5629;
            --success: #4ade80;
            --error: #ef4444;
            --border: #2a2a2a;
        }
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            align-items: center;
            padding: 2rem;
        }
        
        .container { max-width: 600px; width: 100%; }
        
        header { text-align: center; margin-bottom: 2rem; }
        
        h1 {
            font-size: 2.5rem;
            font-weight: 300;
            letter-spacing: 0.1em;
            color: var(--accent);
            margin-bottom: 0.5rem;
        }
        
        .tagline { color: var(--text-secondary); font-size: 0.9rem; }
        
        .card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 2rem;
            margin-bottom: 1rem;
        }
        
        textarea {
            width: 100%;
            min-height: 200px;
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 8px;
            color: var(--text-primary);
            font-family: inherit;
            font-size: 1rem;
            padding: 1rem;
            resize: vertical;
            margin-bottom: 1rem;
        }
        
        textarea:focus { outline: none; border-color: var(--accent); }
        
        .options { display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
        
        .option { display: flex; align-items: center; gap: 0.5rem; }
        
        label { color: var(--text-secondary); font-size: 0.9rem; }
        
        select {
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
            border-radius: 4px;
            color: var(--text-primary);
            padding: 0.5rem;
            font-size: 0.9rem;
        }
        
        button {
            background: var(--accent);
            color: white;
            border: none;
            border-radius: 8px;
            padding: 1rem 2rem;
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
            width: 100%;
        }
        
        button:hover { background: var(--accent-dim); }
        button:disabled { background: var(--border); cursor: not-allowed; }
        
        .result {
            margin-top: 1.5rem;
            padding: 1rem;
            background: var(--bg-tertiary);
            border-radius: 8px;
            display: none;
        }
        
        .result.show { display: block; }
        
        .result-label { color: var(--text-secondary); font-size: 0.8rem; margin-bottom: 0.5rem; }
        
        .result-link {
            word-break: break-all;
            color: var(--success);
            font-family: monospace;
            font-size: 0.9rem;
        }
        
        .copy-btn {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            padding: 0.5rem 1rem;
            margin-top: 0.5rem;
            width: auto;
        }
        
        .copy-btn:hover { background: var(--bg-tertiary); }
        
        .view-mode .card { text-align: center; }
        
        .note-content {
            background: var(--bg-tertiary);
            border-radius: 8px;
            padding: 1.5rem;
            margin: 1rem 0;
            text-align: left;
            white-space: pre-wrap;
            word-break: break-word;
            font-family: inherit;
            line-height: 1.6;
        }
        
        .warning { color: var(--error); font-size: 0.9rem; margin-bottom: 1rem; }
        .success-msg { color: var(--success); }
        .error-msg { color: var(--error); }
        
        .info {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 1rem;
            margin-top: 2rem;
            font-size: 0.85rem;
            color: var(--text-secondary);
        }
        
        .info h3 { color: var(--text-primary); font-size: 1rem; margin-bottom: 0.5rem; }
        .info ul { list-style: none; padding-left: 0; }
        .info li { padding: 0.25rem 0; padding-left: 1.5rem; position: relative; }
        .info li::before { content: "•"; color: var(--accent); position: absolute; left: 0; }
        
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        footer {
            margin-top: auto;
            padding-top: 2rem;
            color: var(--text-secondary);
            font-size: 0.8rem;
            text-align: center;
        }
        
        footer a { color: var(--accent); text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>FLASHPAPER</h1>
            <p class="tagline">Self-destructing encrypted notes</p>
        </header>
        
        <div id="create-mode">
            <div class="card">
                <textarea id="note-input" placeholder="Enter your secret note here..."></textarea>
                
                <div class="options">
                    <div class="option">
                        <label for="ttl">Expires after:</label>
                        <select id="ttl">
                            <option value="3600">1 hour</option>
                            <option value="86400" selected>24 hours</option>
                            <option value="604800">7 days</option>
                        </select>
                    </div>
                </div>
                
                <button id="create-btn" onclick="createNote()">Create Secure Note</button>
                
                <div id="result" class="result">
                    <div class="result-label">Share this link (note will be destroyed after viewing):</div>
                    <div id="result-link" class="result-link"></div>
                    <button class="copy-btn" onclick="copyLink()">Copy Link</button>
                </div>
            </div>
        </div>
        
        <div id="view-mode" style="display: none;">
            <div class="card">
                <p class="warning">⚠️ This note will be permanently destroyed after viewing.</p>
                <button id="reveal-btn" onclick="revealNote()">Reveal Note</button>
                
                <div id="note-display" style="display: none;">
                    <div id="note-content" class="note-content"></div>
                    <button class="copy-btn" id="copy-note-btn" onclick="copyNote()">Copy Message</button>
                    <button onclick="window.location.href='/'">Create New Note</button>
                </div>
            </div>
        </div>
        
        <div id="error-mode" style="display: none;">
            <div class="card">
                <p class="error-msg" id="error-message"></p>
                <button onclick="window.location.href='/'">Create New Note</button>
            </div>
        </div>
        
        <div class="info">
            <h3>🔒 How it works</h3>
            <ul>
                <li>Your note is encrypted in your browser before being sent.</li>
                <li>The encryption key is in the URL fragment. (never sent to server)</li>
                <li>Notes auto-expire and are permanently deleted.</li>
                <li>Once viewed, the note is immediately destroyed.</li>
                 <li>No cookies, trackers, ads. Never fuck your privacy.</li>
            </ul>
        </div>
    </div>
    
    <footer>
        Powered by <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Workers</a> + <a href="https://developers.cloudflare.com/durable-objects/">Durable Objects</a> • Source code <a href="https://github.com/M-Igashi/flashpaper" target="_blank">GitHub</a>
    </footer>

    <script>
        const crypto = window.crypto || window.msCrypto;
        
        async function generateKey() {
            return await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        }
        
        async function exportKey(key) {
            const exported = await crypto.subtle.exportKey('raw', key);
            return btoa(String.fromCharCode(...new Uint8Array(exported)));
        }
        
        async function importKey(keyStr) {
            const keyData = Uint8Array.from(atob(keyStr), c => c.charCodeAt(0));
            return await crypto.subtle.importKey('raw', keyData, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        }
        
        async function encrypt(plaintext, key) {
            const encoder = new TextEncoder();
            const data = encoder.encode(plaintext);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
            const combined = new Uint8Array(iv.length + ciphertext.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(ciphertext), iv.length);
            return btoa(String.fromCharCode(...combined));
        }
        
        async function decrypt(ciphertextB64, key) {
            const combined = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
            return new TextDecoder().decode(decrypted);
        }
        
        let currentLink = '';
        
        async function createNote() {
            const noteInput = document.getElementById('note-input');
            const ttlSelect = document.getElementById('ttl');
            const createBtn = document.getElementById('create-btn');
            const result = document.getElementById('result');
            const resultLink = document.getElementById('result-link');
            
            const plaintext = noteInput.value.trim();
            if (!plaintext) { alert('Please enter a note'); return; }
            
            createBtn.disabled = true;
            createBtn.innerHTML = '<span class="loading"></span> Creating...';
            
            try {
                const key = await generateKey();
                const keyStr = await exportKey(key);
                const ciphertext = await encrypt(plaintext, key);
                
                const payload = { ciphertext };
                const ttl = ttlSelect.value;
                if (ttl) payload.ttl_seconds = parseInt(ttl);
                
                const response = await fetch('/api/note', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (!response.ok) throw new Error('Failed to create note');
                
                const data = await response.json();
                currentLink = location.origin + '/view/' + data.id + '#' + keyStr;
                
                resultLink.textContent = currentLink;
                result.classList.add('show');
                noteInput.value = '';
                
            } catch (error) {
                console.error('Error:', error);
                alert('Failed to create note. Please try again.');
            } finally {
                createBtn.disabled = false;
                createBtn.innerHTML = 'Create Secure Note';
            }
        }
        
        function copyNote() {
            const noteContent = document.getElementById("note-content").textContent;
            navigator.clipboard.writeText(noteContent).then(() => {
                const btn = document.getElementById("copy-note-btn");
                btn.textContent = "Copied!";
                setTimeout(() => btn.textContent = "Copy Message", 2000);
            });
        }
        
        function copyLink() {
            navigator.clipboard.writeText(currentLink).then(() => {
                const btn = document.querySelector('.copy-btn');
                btn.textContent = 'Copied!';
                setTimeout(() => btn.textContent = 'Copy Link', 2000);
            });
        }
        
        let noteId = '', encryptionKey = '';
        
        async function revealNote() {
            const revealBtn = document.getElementById('reveal-btn');
            const noteDisplay = document.getElementById('note-display');
            const noteContent = document.getElementById('note-content');
            
            revealBtn.disabled = true;
            revealBtn.innerHTML = '<span class="loading"></span> Decrypting...';
            
            try {
                const response = await fetch('/api/note/' + noteId);
                const data = await response.json();
                
                if (!data.success) throw new Error(data.error || 'Failed to retrieve note');
                
                const key = await importKey(encryptionKey);
                const plaintext = await decrypt(data.ciphertext, key);
                
                noteContent.textContent = plaintext;
                revealBtn.style.display = 'none';
                document.querySelector('.warning').style.display = 'none';
                noteDisplay.style.display = 'block';
                
            } catch (error) {
                console.error('Error:', error);
                showError(error.message || 'Failed to decrypt note.');
            }
        }
        
        function showError(message) {
            document.getElementById('create-mode').style.display = 'none';
            document.getElementById('view-mode').style.display = 'none';
            document.getElementById('error-mode').style.display = 'block';
            document.getElementById('error-message').textContent = message;
        }
        
        (function init() {
            const path = location.pathname;
            const hash = location.hash.substring(1);
            
            if (path.startsWith('/view/')) {
                noteId = path.split('/view/')[1];
                encryptionKey = hash;
                
                if (!noteId || !encryptionKey) {
                    showError('Invalid link. Missing note ID or encryption key.');
                    return;
                }
                
                document.getElementById('create-mode').style.display = 'none';
                document.getElementById('view-mode').style.display = 'block';
            }
        })();
    </script>
</body>
</html>`;
