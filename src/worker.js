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

      // ===== NOTE API =====
      if (method === 'POST' && path === '/api/note') {
        const body = await request.json();
        const id = generateId();
        
        const namespace = env.NOTE_STORE;
        const stub = namespace.get(namespace.idFromName(id));
        
        response = await stub.fetch(new Request('https://do/store', {
          method: 'POST',
          body: JSON.stringify({ ...body, id }),
        }));

        // Record stats (fire and forget)
        ctx.waitUntil((async () => {
          const statsNamespace = env.STATS_STORE;
          const statsStub = statsNamespace.get(statsNamespace.idFromName('global'));
          await statsStub.fetch(new Request('https://do/record', { method: 'POST' }));
        })());
        
      } else if (method === 'GET' && path.startsWith('/api/note/')) {
        const id = path.replace('/api/note/', '');
        
        const namespace = env.NOTE_STORE;
        const stub = namespace.get(namespace.idFromName(id));
        
        response = await stub.fetch(new Request('https://do/retrieve'));

      // ===== CHAT API =====
      } else if (method === 'POST' && path === '/api/chat') {
        // Create new chat
        const body = await request.json();
        const id = generateId();
        const creatorToken = generateToken();
        const recipientToken = generateToken();
        
        const namespace = env.CHAT_STORE;
        const stub = namespace.get(namespace.idFromName(id));
        
        response = await stub.fetch(new Request('https://do/create', {
          method: 'POST',
          body: JSON.stringify({ 
            id,
            creatorToken,
            recipientToken,
            ttl_seconds: body.ttl_seconds,
            initialMessage: body.ciphertext
          }),
        }));

        // Record stats
        ctx.waitUntil((async () => {
          const statsNamespace = env.STATS_STORE;
          const statsStub = statsNamespace.get(statsNamespace.idFromName('global'));
          await statsStub.fetch(new Request('https://do/record-chat', { method: 'POST' }));
        })());
        
      } else if (method === 'GET' && path.match(/^\/api\/chat\/[^\/]+$/)) {
        // Get chat status and current message
        const id = path.replace('/api/chat/', '');
        const token = url.searchParams.get('token');
        
        if (!token) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else {
          const namespace = env.CHAT_STORE;
          const stub = namespace.get(namespace.idFromName(id));
          
          response = await stub.fetch(new Request('https://do/get?token=' + encodeURIComponent(token)));
        }
        
      } else if (method === 'POST' && path.match(/^\/api\/chat\/[^\/]+\/message$/)) {
        // Send message (destroys previous message)
        const id = path.replace('/api/chat/', '').replace('/message', '');
        const body = await request.json();
        
        if (!body.token) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else {
          const namespace = env.CHAT_STORE;
          const stub = namespace.get(namespace.idFromName(id));
          
          response = await stub.fetch(new Request('https://do/message', {
            method: 'POST',
            body: JSON.stringify({
              token: body.token,
              ciphertext: body.ciphertext
            }),
          }));
        }

      // ===== STATS API =====
      } else if (method === 'GET' && path === '/api/stats') {
        const statsNamespace = env.STATS_STORE;
        const statsStub = statsNamespace.get(statsNamespace.idFromName('global'));
        response = await statsStub.fetch(new Request('https://do/stats'));
        
      // ===== HTML PAGES =====
      } else if (method === 'GET' && (path === '/' || path === '/index.html' || path.startsWith('/view/'))) {
        // Note pages
        const analyticsToken = env.CF_ANALYTICS_TOKEN || '';
        let html = HTML_CONTENT;
        if (analyticsToken) {
          html = html.replace('{{CF_ANALYTICS_TOKEN}}', analyticsToken);
        } else {
          html = html.replace(/<!-- Cloudflare Web Analytics -->.*<!-- End Cloudflare Web Analytics -->/s, '');
        }
        return new Response(html, {
          headers: { 
            'Content-Type': 'text/html; charset=utf-8',
            ...corsHeaders 
          },
        });
        
      } else if (method === 'GET' && (path === '/chat' || path === '/chat/new' || path.match(/^\/chat\/[^\/]+$/))) {
        // Chat pages
        const analyticsToken = env.CF_ANALYTICS_TOKEN || '';
        let html = CHAT_HTML_CONTENT;
        if (analyticsToken) {
          html = html.replace('{{CF_ANALYTICS_TOKEN}}', analyticsToken);
        } else {
          html = html.replace(/<!-- Cloudflare Web Analytics -->.*<!-- End Cloudflare Web Analytics -->/s, '');
        }
        return new Response(html, {
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

  // Cron trigger handler
  async scheduled(event, env, ctx) {
    console.log('Cron triggered: cleaning up old notes and chats');
    
    // Cleanup notes
    const noteNamespace = env.NOTE_STORE;
    const noteStub = noteNamespace.get(noteNamespace.idFromName('__cleanup__'));
    await noteStub.fetch(new Request('https://do/cleanup-all'));
    
    // Cleanup chats
    const chatNamespace = env.CHAT_STORE;
    const chatStub = chatNamespace.get(chatNamespace.idFromName('__cleanup__'));
    await chatStub.fetch(new Request('https://do/cleanup-all'));
    
    console.log('Cleanup completed');
  },
};

function generateId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return timestamp + random;
}

function generateToken() {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

async function hashToken(token) {
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
}

// ===== NOTE STORE DURABLE OBJECT =====
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

    this.cleanupExpired();

    if (path === '/store') {
      const body = await request.json();
      const { id, ciphertext, ttl_seconds } = body;
      
      const now = Date.now();
      const maxRetention = 7 * 24 * 60 * 60 * 1000;
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
      
      this.sql.exec(`DELETE FROM notes WHERE id = ?`, note.id);
      
      return Response.json({
        success: true,
        ciphertext: note.ciphertext,
      });
      
    } else if (path === '/cleanup-all') {
      const now = Date.now();
      this.sql.exec(
        `DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?`,
        now
      );
      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  cleanupExpired() {
    const now = Date.now();
    this.sql.exec(`DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?`, now);
  }
}

// ===== CHAT STORE DURABLE OBJECT =====
export class ChatStore {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    
    this.state.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS chats (
          id TEXT PRIMARY KEY,
          creator_token_hash TEXT NOT NULL,
          recipient_token_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          current_message TEXT,
          current_sender TEXT,
          message_at INTEGER,
          message_read INTEGER DEFAULT 0
        )
      `);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    this.cleanupExpired();

    if (path === '/create') {
      const body = await request.json();
      const { id, creatorToken, recipientToken, ttl_seconds, initialMessage } = body;
      
      const now = Date.now();
      const defaultTTL = 24 * 60 * 60 * 1000; // 24 hours default
      const expiresAt = ttl_seconds 
        ? now + (ttl_seconds * 1000)
        : now + defaultTTL;
      
      const creatorHash = await this.hashToken(creatorToken);
      const recipientHash = await this.hashToken(recipientToken);
      
      this.sql.exec(
        `INSERT INTO chats (id, creator_token_hash, recipient_token_hash, created_at, expires_at, current_message, current_sender, message_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, creatorHash, recipientHash, now, expiresAt,
        initialMessage || null,
        initialMessage ? 'creator' : null,
        initialMessage ? now : null
      );
      
      return Response.json({ 
        success: true,
        id,
        creatorToken,
        recipientToken,
        expiresAt
      });
      
    } else if (path === '/get') {
      const token = url.searchParams.get('token');
      const tokenHash = await this.hashToken(token);
      
      const rows = this.sql.exec(`SELECT * FROM chats LIMIT 1`).toArray();
      
      if (rows.length === 0) {
        return Response.json({ success: false, error: 'Chat not found or expired' });
      }
      
      const chat = rows[0];
      
      if (Date.now() > chat.expires_at) {
        this.sql.exec(`DELETE FROM chats WHERE id = ?`, chat.id);
        return Response.json({ success: false, error: 'Chat has expired' });
      }
      
      // Verify token
      const isCreator = tokenHash === chat.creator_token_hash;
      const isRecipient = tokenHash === chat.recipient_token_hash;
      
      if (!isCreator && !isRecipient) {
        return Response.json({ success: false, error: 'Invalid token' }, { status: 401 });
      }
      
      const role = isCreator ? 'creator' : 'recipient';
      const hasMessage = !!chat.current_message;
      const isMyMessage = chat.current_sender === role;
      
      // Mark as read if viewing other's message
      if (hasMessage && !isMyMessage && !chat.message_read) {
        this.sql.exec(`UPDATE chats SET message_read = 1 WHERE id = ?`, chat.id);
      }
      
      return Response.json({
        success: true,
        role,
        expiresAt: chat.expires_at,
        hasMessage,
        isMyMessage,
        messageRead: !!chat.message_read,
        ciphertext: hasMessage ? chat.current_message : null,
        messageAt: chat.message_at
      });
      
    } else if (path === '/message') {
      const body = await request.json();
      const { token, ciphertext } = body;
      const tokenHash = await this.hashToken(token);
      
      const rows = this.sql.exec(`SELECT * FROM chats LIMIT 1`).toArray();
      
      if (rows.length === 0) {
        return Response.json({ success: false, error: 'Chat not found or expired' });
      }
      
      const chat = rows[0];
      
      if (Date.now() > chat.expires_at) {
        this.sql.exec(`DELETE FROM chats WHERE id = ?`, chat.id);
        return Response.json({ success: false, error: 'Chat has expired' });
      }
      
      // Verify token
      const isCreator = tokenHash === chat.creator_token_hash;
      const isRecipient = tokenHash === chat.recipient_token_hash;
      
      if (!isCreator && !isRecipient) {
        return Response.json({ success: false, error: 'Invalid token' }, { status: 401 });
      }
      
      const role = isCreator ? 'creator' : 'recipient';
      const now = Date.now();
      
      // Replace current message with new one (destroys previous)
      this.sql.exec(
        `UPDATE chats SET current_message = ?, current_sender = ?, message_at = ?, message_read = 0 WHERE id = ?`,
        ciphertext, role, now, chat.id
      );
      
      return Response.json({ 
        success: true,
        messageAt: now
      });
      
    } else if (path === '/cleanup-all') {
      const now = Date.now();
      this.sql.exec(`DELETE FROM chats WHERE expires_at < ?`, now);
      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  async hashToken(token) {
    const encoder = new TextEncoder();
    const data = encoder.encode(token);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
  }

  cleanupExpired() {
    const now = Date.now();
    this.sql.exec(`DELETE FROM chats WHERE expires_at < ?`, now);
  }
}

// ===== STATS STORE DURABLE OBJECT =====
export class StatsStore {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    
    this.state.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS stats (
          date TEXT PRIMARY KEY,
          note_count INTEGER NOT NULL DEFAULT 0,
          chat_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Migration: add chat_count if not exists
      try {
        this.sql.exec(`ALTER TABLE stats ADD COLUMN chat_count INTEGER NOT NULL DEFAULT 0`);
      } catch (e) {
        // Column already exists
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/record' && request.method === 'POST') {
      const today = new Date().toISOString().split('T')[0];
      
      this.sql.exec(`
        INSERT INTO stats (date, note_count, chat_count) VALUES (?, 1, 0)
        ON CONFLICT(date) DO UPDATE SET note_count = note_count + 1
      `, today);
      
      return Response.json({ success: true });
      
    } else if (path === '/record-chat' && request.method === 'POST') {
      const today = new Date().toISOString().split('T')[0];
      
      this.sql.exec(`
        INSERT INTO stats (date, note_count, chat_count) VALUES (?, 0, 1)
        ON CONFLICT(date) DO UPDATE SET chat_count = chat_count + 1
      `, today);
      
      return Response.json({ success: true });
      
    } else if (path === '/stats') {
      const now = new Date();
      
      const today = now.toISOString().split('T')[0];
      
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const oneDayAgo = yesterday.toISOString().split('T')[0];
      
      const oneWeekAgo = new Date(now);
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
      const weekAgo = oneWeekAgo.toISOString().split('T')[0];
      
      const oneMonthAgo = new Date(now);
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const monthAgo = oneMonthAgo.toISOString().split('T')[0];
      
      const oneYearAgo = new Date(now);
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      const yearAgo = oneYearAgo.toISOString().split('T')[0];
      
      const last24h = this.sql.exec(
        `SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`,
        oneDayAgo
      ).toArray()[0] || { notes: 0, chats: 0 };
      
      const last7d = this.sql.exec(
        `SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`,
        weekAgo
      ).toArray()[0] || { notes: 0, chats: 0 };
      
      const last30d = this.sql.exec(
        `SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`,
        monthAgo
      ).toArray()[0] || { notes: 0, chats: 0 };
      
      const last365d = this.sql.exec(
        `SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`,
        yearAgo
      ).toArray()[0] || { notes: 0, chats: 0 };
      
      const allTime = this.sql.exec(
        `SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats`
      ).toArray()[0] || { notes: 0, chats: 0 };
      
      const dailyStats = this.sql.exec(
        `SELECT date, note_count, chat_count FROM stats WHERE date >= ? ORDER BY date ASC`,
        monthAgo
      ).toArray();
      
      return Response.json({
        notes: {
          last_24h: Number(last24h.notes),
          last_7d: Number(last7d.notes),
          last_30d: Number(last30d.notes),
          last_365d: Number(last365d.notes),
          all_time: Number(allTime.notes),
        },
        chats: {
          last_24h: Number(last24h.chats),
          last_7d: Number(last7d.chats),
          last_30d: Number(last30d.chats),
          last_365d: Number(last365d.chats),
          all_time: Number(allTime.chats),
        },
        // Legacy format for backwards compatibility
        last_24h: Number(last24h.notes),
        last_7d: Number(last7d.notes),
        last_30d: Number(last30d.notes),
        last_365d: Number(last365d.notes),
        all_time: Number(allTime.notes),
        daily: dailyStats,
        generated_at: now.toISOString()
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// ===== NOTE HTML =====
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
        
        .nav-links {
            margin-top: 1rem;
            text-align: center;
        }
        
        .nav-links a {
            color: var(--accent);
            text-decoration: none;
            font-size: 0.9rem;
        }
        
        .nav-links a:hover { text-decoration: underline; }
        
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
            
            <div class="nav-links">
                <a href="/chat">💬 Need a conversation? Try Secure Chat →</a>
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
    <!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "{{CF_ANALYTICS_TOKEN}}"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>`;

// ===== CHAT HTML =====
const CHAT_HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flashpaper - Secure Chat</title>
    <style>
        :root {
            --bg-primary: #0a0a0a;
            --bg-secondary: #141414;
            --bg-tertiary: #1a1a1a;
            --text-primary: #e0e0e0;
            --text-secondary: #888;
            --accent: #ff6b35;
            --accent-dim: #cc5629;
            --accent-chat: #6b8aff;
            --accent-chat-dim: #5070dd;
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
            color: var(--accent-chat);
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
            min-height: 150px;
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
        
        textarea:focus { outline: none; border-color: var(--accent-chat); }
        
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
            background: var(--accent-chat);
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
        
        button:hover { background: var(--accent-chat-dim); }
        button:disabled { background: var(--border); cursor: not-allowed; }
        
        .btn-secondary {
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
        }
        
        .btn-secondary:hover { background: var(--bg-secondary); }
        
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
            font-size: 0.85rem;
            margin-bottom: 0.5rem;
        }
        
        .copy-btn {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            padding: 0.5rem 1rem;
            margin-top: 0.5rem;
            width: auto;
        }
        
        .copy-btn:hover { background: var(--bg-tertiary); }
        
        .message-box {
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
        
        .message-box.sent {
            border-left: 3px solid var(--accent-chat);
        }
        
        .message-box.received {
            border-left: 3px solid var(--success);
        }
        
        .message-meta {
            font-size: 0.75rem;
            color: var(--text-secondary);
            margin-bottom: 0.5rem;
        }
        
        .status-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0.75rem 1rem;
            background: var(--bg-tertiary);
            border-radius: 8px;
            margin-bottom: 1rem;
            font-size: 0.85rem;
        }
        
        .status-indicator {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .status-dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: var(--success);
        }
        
        .status-dot.waiting { background: var(--accent); animation: pulse 2s infinite; }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .expires-in { color: var(--text-secondary); }
        
        .warning { color: var(--error); font-size: 0.9rem; margin-bottom: 1rem; }
        .info-text { color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 1rem; }
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
        .info li::before { content: "•"; color: var(--accent-chat); position: absolute; left: 0; }
        
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid var(--border);
            border-top-color: var(--accent-chat);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .nav-links {
            margin-top: 1rem;
            text-align: center;
        }
        
        .nav-links a {
            color: var(--accent);
            text-decoration: none;
            font-size: 0.9rem;
        }
        
        .nav-links a:hover { text-decoration: underline; }
        
        .button-group {
            display: flex;
            gap: 0.5rem;
            margin-top: 1rem;
        }
        
        .button-group button {
            flex: 1;
        }
        
        footer {
            margin-top: auto;
            padding-top: 2rem;
            color: var(--text-secondary);
            font-size: 0.8rem;
            text-align: center;
        }
        
        footer a { color: var(--accent-chat); text-decoration: none; }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>💬 SECURE CHAT</h1>
            <p class="tagline">Ephemeral encrypted conversations</p>
        </header>
        
        <!-- Create Mode -->
        <div id="create-mode">
            <div class="card">
                <textarea id="initial-message" placeholder="Enter your first message (optional)..."></textarea>
                
                <div class="options">
                    <div class="option">
                        <label for="ttl">Chat expires after:</label>
                        <select id="ttl">
                            <option value="3600">1 hour</option>
                            <option value="86400" selected>24 hours</option>
                            <option value="604800">7 days</option>
                        </select>
                    </div>
                </div>
                
                <button id="create-btn" onclick="createChat()">Start Secure Chat</button>
                
                <div id="result" class="result">
                    <div class="result-label">🔗 Your link (keep this private):</div>
                    <div id="creator-link" class="result-link"></div>
                    <button class="copy-btn" onclick="copyCreatorLink()">Copy My Link</button>
                    
                    <div style="margin-top: 1.5rem;">
                        <div class="result-label">📤 Share this link with your contact:</div>
                        <div id="share-link" class="result-link"></div>
                        <button class="copy-btn" onclick="copyShareLink()">Copy Share Link</button>
                    </div>
                    
                    <div class="button-group">
                        <button onclick="goToChat()">Enter Chat →</button>
                    </div>
                </div>
            </div>
            
            <div class="nav-links">
                <a href="/">📝 Need one-time note? Go to Notes →</a>
            </div>
        </div>
        
        <!-- Chat Mode -->
        <div id="chat-mode" style="display: none;">
            <div class="card">
                <div class="status-bar">
                    <div class="status-indicator">
                        <div class="status-dot" id="status-dot"></div>
                        <span id="status-text">Connected</span>
                    </div>
                    <div class="expires-in" id="expires-in"></div>
                </div>
                
                <!-- Message Display -->
                <div id="message-area">
                    <div id="no-message" class="info-text" style="text-align: center; padding: 2rem;">
                        No messages yet. Send the first message!
                    </div>
                    
                    <div id="message-display" style="display: none;">
                        <div class="message-meta" id="message-meta"></div>
                        <div class="message-box" id="message-content"></div>
                        <button class="copy-btn" onclick="copyMessage()">Copy Message</button>
                    </div>
                    
                    <div id="waiting-display" style="display: none; text-align: center; padding: 2rem;">
                        <p class="info-text">⏳ Waiting for reply...</p>
                        <p class="info-text" style="font-size: 0.8rem; margin-top: 0.5rem;">Your message was sent. Refresh to check for new messages.</p>
                    </div>
                </div>
                
                <!-- Reply Area -->
                <div id="reply-area" style="margin-top: 1.5rem;">
                    <textarea id="reply-input" placeholder="Type your reply..."></textarea>
                    <p class="warning" style="font-size: 0.8rem;">⚠️ Sending will destroy the current message above</p>
                    <button id="send-btn" onclick="sendMessage()">Send Message</button>
                </div>
            </div>
            
            <div class="button-group">
                <button class="btn-secondary" onclick="refreshChat()">🔄 Refresh</button>
                <button class="btn-secondary" onclick="window.location.href='/chat'">+ New Chat</button>
            </div>
        </div>
        
        <!-- Error Mode -->
        <div id="error-mode" style="display: none;">
            <div class="card">
                <p class="error-msg" id="error-message"></p>
                <button onclick="window.location.href='/chat'">Start New Chat</button>
            </div>
        </div>
        
        <div class="info">
            <h3>🔒 How Secure Chat works</h3>
            <ul>
                <li>Messages are encrypted in your browser (AES-256-GCM)</li>
                <li>Only ONE message exists at a time - previous is destroyed on reply</li>
                <li>Encryption key stays in URL fragment (never sent to server)</li>
                <li>Chat auto-expires and is permanently deleted</li>
                <li>No message history, no logs, no traces</li>
            </ul>
        </div>
    </div>
    
    <footer>
        Powered by <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Workers</a> • <a href="/">Notes</a> • <a href="https://github.com/M-Igashi/flashpaper" target="_blank">GitHub</a>
    </footer>

    <script>
        const cryptoApi = window.crypto || window.msCrypto;
        
        // Crypto functions
        async function generateKey() {
            return await cryptoApi.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        }
        
        async function exportKey(key) {
            const exported = await cryptoApi.subtle.exportKey('raw', key);
            return btoa(String.fromCharCode(...new Uint8Array(exported)));
        }
        
        async function importKey(keyStr) {
            const keyData = Uint8Array.from(atob(keyStr), c => c.charCodeAt(0));
            return await cryptoApi.subtle.importKey('raw', keyData, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        }
        
        async function encrypt(plaintext, key) {
            const encoder = new TextEncoder();
            const data = encoder.encode(plaintext);
            const iv = cryptoApi.getRandomValues(new Uint8Array(12));
            const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
            const combined = new Uint8Array(iv.length + ciphertext.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(ciphertext), iv.length);
            return btoa(String.fromCharCode(...combined));
        }
        
        async function decrypt(ciphertextB64, key) {
            const combined = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);
            const decrypted = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
            return new TextDecoder().decode(decrypted);
        }
        
        // State
        let chatId = '';
        let encryptionKey = null;
        let encryptionKeyStr = '';
        let userToken = '';
        let creatorLink = '';
        let shareLink = '';
        let currentRole = '';
        
        // Parse URL: /chat/{id}#{key}:{token}
        function parseUrl() {
            const path = location.pathname;
            const hash = location.hash.substring(1);
            
            if (path.match(/^\\/chat\\/[^/]+$/)) {
                chatId = path.split('/chat/')[1];
                
                if (hash) {
                    const parts = hash.split(':');
                    if (parts.length === 2) {
                        encryptionKeyStr = parts[0];
                        userToken = parts[1];
                        return true;
                    }
                }
            }
            return false;
        }
        
        // Create new chat
        async function createChat() {
            const initialMessage = document.getElementById('initial-message').value.trim();
            const ttlSelect = document.getElementById('ttl');
            const createBtn = document.getElementById('create-btn');
            const result = document.getElementById('result');
            
            createBtn.disabled = true;
            createBtn.innerHTML = '<span class="loading"></span> Creating...';
            
            try {
                encryptionKey = await generateKey();
                encryptionKeyStr = await exportKey(encryptionKey);
                
                const payload = { ttl_seconds: parseInt(ttlSelect.value) };
                
                if (initialMessage) {
                    payload.ciphertext = await encrypt(initialMessage, encryptionKey);
                }
                
                const response = await fetch('/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                
                if (!response.ok) throw new Error('Failed to create chat');
                
                const data = await response.json();
                chatId = data.id;
                
                creatorLink = location.origin + '/chat/' + chatId + '#' + encryptionKeyStr + ':' + data.creatorToken;
                shareLink = location.origin + '/chat/' + chatId + '#' + encryptionKeyStr + ':' + data.recipientToken;
                userToken = data.creatorToken;
                
                document.getElementById('creator-link').textContent = creatorLink;
                document.getElementById('share-link').textContent = shareLink;
                result.classList.add('show');
                
            } catch (error) {
                console.error('Error:', error);
                alert('Failed to create chat. Please try again.');
            } finally {
                createBtn.disabled = false;
                createBtn.innerHTML = 'Start Secure Chat';
            }
        }
        
        function copyCreatorLink() {
            navigator.clipboard.writeText(creatorLink).then(() => {
                event.target.textContent = 'Copied!';
                setTimeout(() => event.target.textContent = 'Copy My Link', 2000);
            });
        }
        
        function copyShareLink() {
            navigator.clipboard.writeText(shareLink).then(() => {
                event.target.textContent = 'Copied!';
                setTimeout(() => event.target.textContent = 'Copy Share Link', 2000);
            });
        }
        
        function goToChat() {
            window.location.href = creatorLink;
        }
        
        // Load chat
        async function loadChat() {
            try {
                encryptionKey = await importKey(encryptionKeyStr);
                
                const response = await fetch('/api/chat/' + chatId + '?token=' + encodeURIComponent(userToken));
                const data = await response.json();
                
                if (!data.success) {
                    showError(data.error || 'Chat not found');
                    return;
                }
                
                currentRole = data.role;
                updateExpiresIn(data.expiresAt);
                
                const noMessage = document.getElementById('no-message');
                const messageDisplay = document.getElementById('message-display');
                const waitingDisplay = document.getElementById('waiting-display');
                const replyArea = document.getElementById('reply-area');
                const statusDot = document.getElementById('status-dot');
                const statusText = document.getElementById('status-text');
                
                if (!data.hasMessage) {
                    // No message yet
                    noMessage.style.display = 'block';
                    messageDisplay.style.display = 'none';
                    waitingDisplay.style.display = 'none';
                    replyArea.style.display = 'block';
                    statusDot.className = 'status-dot';
                    statusText.textContent = 'Ready';
                } else if (data.isMyMessage) {
                    // I sent the last message, waiting for reply
                    noMessage.style.display = 'none';
                    messageDisplay.style.display = 'none';
                    waitingDisplay.style.display = 'block';
                    replyArea.style.display = 'none';
                    statusDot.className = 'status-dot waiting';
                    statusText.textContent = data.messageRead ? 'Message read' : 'Sent, waiting...';
                } else {
                    // Received message
                    noMessage.style.display = 'none';
                    waitingDisplay.style.display = 'none';
                    messageDisplay.style.display = 'block';
                    replyArea.style.display = 'block';
                    statusDot.className = 'status-dot';
                    statusText.textContent = 'New message';
                    
                    const plaintext = await decrypt(data.ciphertext, encryptionKey);
                    document.getElementById('message-content').textContent = plaintext;
                    document.getElementById('message-content').className = 'message-box received';
                    
                    const msgTime = new Date(data.messageAt).toLocaleString();
                    document.getElementById('message-meta').textContent = 'Received • ' + msgTime;
                }
                
            } catch (error) {
                console.error('Error:', error);
                showError('Failed to load chat: ' + error.message);
            }
        }
        
        function updateExpiresIn(expiresAt) {
            const now = Date.now();
            const remaining = expiresAt - now;
            
            if (remaining <= 0) {
                document.getElementById('expires-in').textContent = 'Expired';
                return;
            }
            
            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
            
            if (hours > 24) {
                const days = Math.floor(hours / 24);
                document.getElementById('expires-in').textContent = 'Expires in ' + days + 'd';
            } else if (hours > 0) {
                document.getElementById('expires-in').textContent = 'Expires in ' + hours + 'h ' + minutes + 'm';
            } else {
                document.getElementById('expires-in').textContent = 'Expires in ' + minutes + 'm';
            }
        }
        
        async function sendMessage() {
            const replyInput = document.getElementById('reply-input');
            const sendBtn = document.getElementById('send-btn');
            const plaintext = replyInput.value.trim();
            
            if (!plaintext) {
                alert('Please enter a message');
                return;
            }
            
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<span class="loading"></span> Sending...';
            
            try {
                const ciphertext = await encrypt(plaintext, encryptionKey);
                
                const response = await fetch('/api/chat/' + chatId + '/message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        token: userToken,
                        ciphertext
                    })
                });
                
                const data = await response.json();
                
                if (!data.success) {
                    throw new Error(data.error || 'Failed to send message');
                }
                
                replyInput.value = '';
                await loadChat();
                
            } catch (error) {
                console.error('Error:', error);
                alert('Failed to send message: ' + error.message);
            } finally {
                sendBtn.disabled = false;
                sendBtn.innerHTML = 'Send Message';
            }
        }
        
        function copyMessage() {
            const content = document.getElementById('message-content').textContent;
            navigator.clipboard.writeText(content).then(() => {
                event.target.textContent = 'Copied!';
                setTimeout(() => event.target.textContent = 'Copy Message', 2000);
            });
        }
        
        function refreshChat() {
            loadChat();
        }
        
        function showError(message) {
            document.getElementById('create-mode').style.display = 'none';
            document.getElementById('chat-mode').style.display = 'none';
            document.getElementById('error-mode').style.display = 'block';
            document.getElementById('error-message').textContent = message;
        }
        
        // Initialize
        (function init() {
            const path = location.pathname;
            
            if (path === '/chat' || path === '/chat/new') {
                // Create mode
                document.getElementById('create-mode').style.display = 'block';
            } else if (parseUrl()) {
                // Chat mode
                document.getElementById('create-mode').style.display = 'none';
                document.getElementById('chat-mode').style.display = 'block';
                loadChat();
            } else {
                showError('Invalid chat link');
            }
        })();
    </script>
    <!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "{{CF_ANALYTICS_TOKEN}}"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>`;
