export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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
            creatorSessionId: body.sessionId,
            ttl_seconds: body.ttl_seconds,
            initialMessage: body.ciphertext
          }),
        }));

        ctx.waitUntil((async () => {
          const statsNamespace = env.STATS_STORE;
          const statsStub = statsNamespace.get(statsNamespace.idFromName('global'));
          await statsStub.fetch(new Request('https://do/record-chat', { method: 'POST' }));
        })());
        
      } else if (method === 'GET' && path.match(/^\/api\/chat\/[^\/]+$/)) {
        const id = path.replace('/api/chat/', '');
        const token = url.searchParams.get('token');
        const sessionId = url.searchParams.get('sessionId');
        
        if (!token) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else if (!sessionId) {
          response = Response.json({ success: false, error: 'Session ID required' }, { status: 401 });
        } else {
          const namespace = env.CHAT_STORE;
          const stub = namespace.get(namespace.idFromName(id));
          
          response = await stub.fetch(new Request('https://do/get?token=' + encodeURIComponent(token) + '&sessionId=' + encodeURIComponent(sessionId)));
        }
        
      } else if (method === 'POST' && path.match(/^\/api\/chat\/[^\/]+\/message$/)) {
        const id = path.replace('/api/chat/', '').replace('/message', '');
        const body = await request.json();
        
        if (!body.token) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else if (!body.sessionId) {
          response = Response.json({ success: false, error: 'Session ID required' }, { status: 401 });
        } else {
          const namespace = env.CHAT_STORE;
          const stub = namespace.get(namespace.idFromName(id));
          
          response = await stub.fetch(new Request('https://do/message', {
            method: 'POST',
            body: JSON.stringify({
              token: body.token,
              sessionId: body.sessionId,
              ciphertext: body.ciphertext
            }),
          }));
        }
        
      } else if (method === 'DELETE' && path.match(/^\/api\/chat\/[^\/]+$/)) {
        const id = path.replace('/api/chat/', '');
        const token = url.searchParams.get('token');
        const sessionId = url.searchParams.get('sessionId');
        
        if (!token) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else {
          const namespace = env.CHAT_STORE;
          const stub = namespace.get(namespace.idFromName(id));
          
          response = await stub.fetch(new Request('https://do/destroy?token=' + encodeURIComponent(token) + '&sessionId=' + encodeURIComponent(sessionId || ''), {
            method: 'DELETE'
          }));
        }

      // ===== STATS API =====
      } else if (method === 'GET' && path === '/api/stats') {
        const statsNamespace = env.STATS_STORE;
        const statsStub = statsNamespace.get(statsNamespace.idFromName('global'));
        response = await statsStub.fetch(new Request('https://do/stats'));
        
      // ===== STATIC FILES (R2) =====
      } else if (method === 'GET' && path === '/google174732a25afed9fc.html') {
        const object = await env.SITE_BUCKET.get('google174732a25afed9fc.html');
        if (object === null) {
          response = new Response('Not Found', { status: 404 });
        } else {
          return new Response(object.body, {
            headers: { 
              'Content-Type': 'text/html; charset=utf-8',
              ...corsHeaders 
            },
          });
        }

      } else if (method === 'GET' && path === '/sitemap.xml') {
        const object = await env.SITE_BUCKET.get('sitemap.xml');
        if (object === null) {
          response = new Response('Not Found', { status: 404 });
        } else {
          return new Response(object.body, {
            headers: { 
              'Content-Type': 'application/xml; charset=utf-8',
              ...corsHeaders 
            },
          });
        }

      // ===== HTML PAGES =====
      } else if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/chat' || path === '/chat/new' || path.startsWith('/view/') || path.match(/^\/chat\/[^\/]+$/))) {
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

  async scheduled(event, env, ctx) {
    console.log('Cron triggered: cleaning up old notes and chats');
    
    const noteNamespace = env.NOTE_STORE;
    const noteStub = noteNamespace.get(noteNamespace.idFromName('__cleanup__'));
    await noteStub.fetch(new Request('https://do/cleanup-all'));
    
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

// ===== NOTE STORE =====
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
        return Response.json({ success: false, error: 'Note not found or already read' });
      }
      
      const note = rows[0];
      
      if (note.expires_at && Date.now() > note.expires_at) {
        this.sql.exec(`DELETE FROM notes WHERE id = ?`, note.id);
        return Response.json({ success: false, error: 'Note has expired' });
      }
      
      this.sql.exec(`DELETE FROM notes WHERE id = ?`, note.id);
      
      return Response.json({ success: true, ciphertext: note.ciphertext });
      
    } else if (path === '/cleanup-all') {
      const now = Date.now();
      this.sql.exec(`DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?`, now);
      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  cleanupExpired() {
    const now = Date.now();
    this.sql.exec(`DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at < ?`, now);
  }
}

// ===== CHAT STORE =====
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
          creator_session_hash TEXT,
          recipient_session_hash TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          current_message TEXT,
          current_sender TEXT,
          message_at INTEGER,
          message_read INTEGER DEFAULT 0
        )
      `);
      // Migration
      try { this.sql.exec(`ALTER TABLE chats ADD COLUMN creator_session_hash TEXT`); } catch (e) {}
      try { this.sql.exec(`ALTER TABLE chats ADD COLUMN recipient_session_hash TEXT`); } catch (e) {}
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    this.cleanupExpired();

    if (path === '/create') {
      const body = await request.json();
      const { id, creatorToken, recipientToken, creatorSessionId, ttl_seconds, initialMessage } = body;
      
      const now = Date.now();
      const defaultTTL = 24 * 60 * 60 * 1000;
      const expiresAt = ttl_seconds 
        ? now + (ttl_seconds * 1000)
        : now + defaultTTL;
      
      const creatorHash = await this.hashToken(creatorToken);
      const recipientHash = await this.hashToken(recipientToken);
      const creatorSessionHash = creatorSessionId ? await this.hashToken(creatorSessionId) : null;
      
      this.sql.exec(
        `INSERT INTO chats (id, creator_token_hash, recipient_token_hash, creator_session_hash, recipient_session_hash, created_at, expires_at, current_message, current_sender, message_at) 
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        id, creatorHash, recipientHash, creatorSessionHash, now, expiresAt,
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
      const sessionId = url.searchParams.get('sessionId');
      const tokenHash = await this.hashToken(token);
      const sessionHash = await this.hashToken(sessionId);
      
      const rows = this.sql.exec(`SELECT * FROM chats LIMIT 1`).toArray();
      
      if (rows.length === 0) {
        return Response.json({ success: false, error: 'Chat not found or expired' });
      }
      
      const chat = rows[0];
      
      if (Date.now() > chat.expires_at) {
        this.sql.exec(`DELETE FROM chats WHERE id = ?`, chat.id);
        return Response.json({ success: false, error: 'Chat has expired' });
      }
      
      const isCreator = tokenHash === chat.creator_token_hash;
      const isRecipient = tokenHash === chat.recipient_token_hash;
      
      if (!isCreator && !isRecipient) {
        return Response.json({ success: false, error: 'Invalid token' }, { status: 401 });
      }
      
      // Session binding check
      if (isCreator) {
        if (chat.creator_session_hash && chat.creator_session_hash !== sessionHash) {
          return Response.json({ success: false, error: 'Session mismatch - this chat is bound to another browser' }, { status: 403 });
        }
        // Bind session if not yet bound
        if (!chat.creator_session_hash) {
          this.sql.exec(`UPDATE chats SET creator_session_hash = ? WHERE id = ?`, sessionHash, chat.id);
        }
      } else {
        // Recipient
        if (chat.recipient_session_hash && chat.recipient_session_hash !== sessionHash) {
          return Response.json({ success: false, error: 'Session mismatch - this chat is bound to another browser' }, { status: 403 });
        }
        // Bind session if not yet bound (first access)
        if (!chat.recipient_session_hash) {
          this.sql.exec(`UPDATE chats SET recipient_session_hash = ? WHERE id = ?`, sessionHash, chat.id);
        }
      }
      
      const role = isCreator ? 'creator' : 'recipient';
      const hasMessage = !!chat.current_message;
      const isMyMessage = chat.current_sender === role;
      
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
      const { token, sessionId, ciphertext } = body;
      const tokenHash = await this.hashToken(token);
      const sessionHash = await this.hashToken(sessionId);
      
      const rows = this.sql.exec(`SELECT * FROM chats LIMIT 1`).toArray();
      
      if (rows.length === 0) {
        return Response.json({ success: false, error: 'Chat not found or expired' });
      }
      
      const chat = rows[0];
      
      if (Date.now() > chat.expires_at) {
        this.sql.exec(`DELETE FROM chats WHERE id = ?`, chat.id);
        return Response.json({ success: false, error: 'Chat has expired' });
      }
      
      const isCreator = tokenHash === chat.creator_token_hash;
      const isRecipient = tokenHash === chat.recipient_token_hash;
      
      if (!isCreator && !isRecipient) {
        return Response.json({ success: false, error: 'Invalid token' }, { status: 401 });
      }
      
      // Session binding check
      if (isCreator && chat.creator_session_hash && chat.creator_session_hash !== sessionHash) {
        return Response.json({ success: false, error: 'Session mismatch' }, { status: 403 });
      }
      if (isRecipient && chat.recipient_session_hash && chat.recipient_session_hash !== sessionHash) {
        return Response.json({ success: false, error: 'Session mismatch' }, { status: 403 });
      }
      
      const role = isCreator ? 'creator' : 'recipient';
      const now = Date.now();
      
      this.sql.exec(
        `UPDATE chats SET current_message = ?, current_sender = ?, message_at = ?, message_read = 0 WHERE id = ?`,
        ciphertext, role, now, chat.id
      );
      
      return Response.json({ success: true, messageAt: now });
      
    } else if (path === '/destroy') {
      const token = url.searchParams.get('token');
      const sessionId = url.searchParams.get('sessionId');
      const tokenHash = await this.hashToken(token);
      const sessionHash = sessionId ? await this.hashToken(sessionId) : null;
      
      const rows = this.sql.exec(`SELECT * FROM chats LIMIT 1`).toArray();
      
      if (rows.length === 0) {
        return Response.json({ success: false, error: 'Chat not found or already destroyed' });
      }
      
      const chat = rows[0];
      
      const isCreator = tokenHash === chat.creator_token_hash;
      const isRecipient = tokenHash === chat.recipient_token_hash;
      
      if (!isCreator && !isRecipient) {
        return Response.json({ success: false, error: 'Invalid token' }, { status: 401 });
      }
      
      // Session check for destroy (if session exists)
      if (sessionHash) {
        if (isCreator && chat.creator_session_hash && chat.creator_session_hash !== sessionHash) {
          return Response.json({ success: false, error: 'Session mismatch' }, { status: 403 });
        }
        if (isRecipient && chat.recipient_session_hash && chat.recipient_session_hash !== sessionHash) {
          return Response.json({ success: false, error: 'Session mismatch' }, { status: 403 });
        }
      }
      
      this.sql.exec(`DELETE FROM chats WHERE id = ?`, chat.id);
      
      return Response.json({ success: true, message: 'Chat destroyed' });
      
    } else if (path === '/cleanup-all') {
      const now = Date.now();
      this.sql.exec(`DELETE FROM chats WHERE expires_at < ?`, now);
      return Response.json({ success: true });
    }

    return new Response('Not Found', { status: 404 });
  }

  async hashToken(token) {
    if (!token) return null;
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

// ===== STATS STORE =====
export class StatsStore {
  constructor(state, env) {
    this.state = state;
    this.sql = state.storage.sql;
    
    this.state.blockConcurrencyWhile(async () => {
      // Check if old schema exists (with 'count' column)
      try {
        const tableInfo = this.sql.exec(`PRAGMA table_info(stats)`).toArray();
        const hasOldCount = tableInfo.some(col => col.name === 'count');
        const hasNoteCount = tableInfo.some(col => col.name === 'note_count');
        
        if (hasOldCount && !hasNoteCount) {
          // Migrate from old schema to new schema
          this.sql.exec(`ALTER TABLE stats RENAME COLUMN count TO note_count`);
          try {
            this.sql.exec(`ALTER TABLE stats ADD COLUMN chat_count INTEGER NOT NULL DEFAULT 0`);
          } catch (e) {}
        } else if (!hasNoteCount) {
          // Fresh install - create new schema
          this.sql.exec(`
            CREATE TABLE IF NOT EXISTS stats (
              date TEXT PRIMARY KEY,
              note_count INTEGER NOT NULL DEFAULT 0,
              chat_count INTEGER NOT NULL DEFAULT 0
            )
          `);
        } else {
          // Already migrated, just ensure chat_count exists
          try {
            this.sql.exec(`ALTER TABLE stats ADD COLUMN chat_count INTEGER NOT NULL DEFAULT 0`);
          } catch (e) {}
        }
      } catch (e) {
        // Table doesn't exist, create it fresh
        this.sql.exec(`
          CREATE TABLE IF NOT EXISTS stats (
            date TEXT PRIMARY KEY,
            note_count INTEGER NOT NULL DEFAULT 0,
            chat_count INTEGER NOT NULL DEFAULT 0
          )
        `);
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
      const oneDayAgo = new Date(now); oneDayAgo.setDate(oneDayAgo.getDate() - 1);
      const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
      const monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);
      const yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      
      const fmt = d => d.toISOString().split('T')[0];
      
      const last24h = this.sql.exec(`SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`, fmt(oneDayAgo)).toArray()[0] || { notes: 0, chats: 0 };
      const last7d = this.sql.exec(`SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`, fmt(weekAgo)).toArray()[0] || { notes: 0, chats: 0 };
      const last30d = this.sql.exec(`SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`, fmt(monthAgo)).toArray()[0] || { notes: 0, chats: 0 };
      const last365d = this.sql.exec(`SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats WHERE date >= ?`, fmt(yearAgo)).toArray()[0] || { notes: 0, chats: 0 };
      const allTime = this.sql.exec(`SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats`).toArray()[0] || { notes: 0, chats: 0 };
      const dailyStats = this.sql.exec(`SELECT date, note_count, chat_count FROM stats WHERE date >= ? ORDER BY date ASC`, fmt(monthAgo)).toArray();
      
      return Response.json({
        notes: { last_24h: Number(last24h.notes), last_7d: Number(last7d.notes), last_30d: Number(last30d.notes), last_365d: Number(last365d.notes), all_time: Number(allTime.notes) },
        chats: { last_24h: Number(last24h.chats), last_7d: Number(last7d.chats), last_30d: Number(last30d.chats), last_365d: Number(last365d.chats), all_time: Number(allTime.chats) },
        last_24h: Number(last24h.notes), last_7d: Number(last7d.notes), last_30d: Number(last30d.notes), last_365d: Number(last365d.notes), all_time: Number(allTime.notes),
        daily: dailyStats,
        generated_at: now.toISOString()
      });
    }

    return new Response('Not Found', { status: 404 });
  }
}

// ===== UNIFIED HTML =====
const HTML_CONTENT = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Flashpaper - Self-Destructing Encrypted Note/Chat</title>
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
        
        header { text-align: center; margin-bottom: 1.5rem; }
        
        h1 {
            font-size: 2.5rem;
            font-weight: 300;
            letter-spacing: 0.1em;
            margin-bottom: 0.5rem;
        }
        
        h1.note-mode { color: var(--accent); }
        h1.chat-mode { color: var(--accent-chat); }
        
        .tagline { color: var(--text-secondary); font-size: 0.9rem; }
        
        .tabs {
            display: flex;
            margin-bottom: 1.5rem;
            background: var(--bg-secondary);
            border-radius: 8px;
            padding: 4px;
        }
        
        .tab {
            flex: 1;
            padding: 0.75rem 1rem;
            text-align: center;
            cursor: pointer;
            border-radius: 6px;
            font-weight: 500;
            transition: all 0.2s;
            color: var(--text-secondary);
        }
        
        .tab:hover { color: var(--text-primary); }
        .tab.active-note { background: var(--accent); color: white; }
        .tab.active-chat { background: var(--accent-chat); color: white; }
        
        .card {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 2rem;
            margin-bottom: 1rem;
        }
        
        textarea {
            width: 100%;
            min-height: 180px;
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
        textarea.chat-focus:focus { border-color: var(--accent-chat); }
        
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
        
        button.btn-chat { background: var(--accent-chat); }
        button.btn-chat:hover { background: var(--accent-chat-dim); }
        
        button.btn-secondary {
            background: var(--bg-tertiary);
            border: 1px solid var(--border);
        }
        button.btn-secondary:hover { background: var(--bg-secondary); }
        
        button.btn-danger { background: var(--error); }
        button.btn-danger:hover { background: #dc2626; }
        
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
        
        .message-box.received { border-left: 3px solid var(--success); }
        
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
        
        .status-indicator { display: flex; align-items: center; gap: 0.5rem; }
        
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
        .info li::before { content: "•"; position: absolute; left: 0; }
        .info.note-info li::before { color: var(--accent); }
        .info.chat-info li::before { color: var(--accent-chat); }
        
        .loading {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid var(--border);
            border-top-color: var(--accent);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        .loading.chat { border-top-color: var(--accent-chat); }
        
        @keyframes spin { to { transform: rotate(360deg); } }
        
        .button-group {
            display: flex;
            gap: 0.5rem;
            margin-top: 1rem;
        }
        
        .button-group button { flex: 1; }
        
        .auto-refresh-indicator {
            font-size: 0.7rem;
            color: var(--text-secondary);
            margin-left: 0.5rem;
        }
        
        footer {
            margin-top: auto;
            padding-top: 2rem;
            color: var(--text-secondary);
            font-size: 0.8rem;
            text-align: center;
        }
        
        footer a { color: var(--accent); text-decoration: none; }
        
        .hidden { display: none !important; }
        
        /* Custom Modal */
        .modal-overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 1000;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
        }
        
        .modal-overlay.show {
            opacity: 1;
            visibility: visible;
        }
        
        .modal-content {
            background: var(--bg-secondary);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 2rem;
            max-width: 400px;
            width: 90%;
            text-align: center;
            transform: scale(0.9);
            transition: transform 0.2s;
        }
        
        .modal-overlay.show .modal-content {
            transform: scale(1);
        }
        
        .modal-title {
            font-size: 1.25rem;
            font-weight: 600;
            margin-bottom: 1rem;
            color: var(--text-primary);
        }
        
        .modal-message {
            color: var(--text-secondary);
            margin-bottom: 1.5rem;
            line-height: 1.5;
        }
        
        .modal-buttons {
            display: flex;
            gap: 0.75rem;
        }
        
        .modal-buttons button {
            flex: 1;
            padding: 0.75rem 1rem;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1 id="main-title" class="note-mode">FLASHPAPER</h1>
            <p class="tagline">Self-destructing encrypted note/chat</p>
        </header>
        
        <div class="tabs" id="tabs">
            <div class="tab active-note" id="tab-note" onclick="switchTab('note')">📝 Note</div>
            <div class="tab" id="tab-chat" onclick="switchTab('chat')">💬 Chat</div>
        </div>
        
        <!-- NOTE CREATE MODE -->
        <div id="note-create-mode">
            <div class="card">
                <textarea id="note-input" placeholder="Enter your secret note here..."></textarea>
                <div class="options">
                    <div class="option">
                        <label for="note-ttl">Expires after:</label>
                        <select id="note-ttl">
                            <option value="3600">1 hour</option>
                            <option value="86400" selected>24 hours</option>
                            <option value="604800">7 days</option>
                        </select>
                    </div>
                </div>
                <button id="note-create-btn" onclick="createNote()">Create Secure Note</button>
                <div id="note-result" class="result">
                    <div class="result-label">Share this link (note will be destroyed after viewing):</div>
                    <div id="note-result-link" class="result-link"></div>
                    <button class="copy-btn" onclick="copyNoteLink()">Copy Link</button>
                </div>
            </div>
            <div class="info note-info">
                <h3>🔒 How it works</h3>
                <ul>
                    <li>Your note is encrypted in your browser before being sent.</li>
                    <li>The encryption key is in the URL fragment (never sent to server).</li>
                    <li>Notes auto-expire and are permanently deleted.</li>
                    <li>Once viewed, the note is immediately destroyed.</li>
                </ul>
            </div>
        </div>
        
        <!-- NOTE VIEW MODE -->
        <div id="note-view-mode" class="hidden">
            <div class="card">
                <p class="warning">⚠️ This note will be permanently destroyed after viewing.</p>
                <button id="note-reveal-btn" onclick="revealNote()">Reveal Note</button>
                <div id="note-display" class="hidden">
                    <div id="note-content" class="message-box"></div>
                    <button class="copy-btn" onclick="copyNoteContent()">Copy Message</button>
                    <button onclick="window.location.href='/'">Create New</button>
                </div>
            </div>
        </div>
        
        <!-- CHAT CREATE MODE -->
        <div id="chat-create-mode" class="hidden">
            <div class="card">
                <textarea id="chat-initial-message" class="chat-focus" placeholder="Enter your first message (optional)..."></textarea>
                <div class="options">
                    <div class="option">
                        <label for="chat-ttl">Chat expires after:</label>
                        <select id="chat-ttl">
                            <option value="3600">1 hour</option>
                            <option value="86400" selected>24 hours</option>
                            <option value="604800">7 days</option>
                        </select>
                    </div>
                </div>
                <button id="chat-create-btn" class="btn-chat" onclick="createChat()">Start Secure Chat</button>
                <div id="chat-result" class="result">
                    <div class="result-label">📤 Share this link with your contact:</div>
                    <div id="chat-share-link" class="result-link"></div>
                    <button class="copy-btn" onclick="copyShareLink()">Copy Share Link</button>
                    <div class="button-group" style="margin-top: 1.5rem;">
                        <button class="btn-chat" onclick="goToChat()">Go to Chat →</button>
                    </div>
                </div>
            </div>
            <div class="info chat-info">
                <h3>🔒 How Secure Chat works</h3>
                <ul>
                    <li>Messages are encrypted in your browser (AES-256-GCM).</li>
                    <li>Only ONE message exists at a time - previous is destroyed on reply.</li>
                    <li>Chat is bound to the first browser that opens each link.</li>
                    <li>Encryption key stays in URL fragment (never sent to server).</li>
                    <li>Chat auto-expires and is permanently deleted.</li>
                </ul>
            </div>
        </div>
        
        <!-- CHAT SESSION MODE -->
        <div id="chat-session-mode" class="hidden">
            <div class="card">
                <div class="status-bar">
                    <div class="status-indicator">
                        <div class="status-dot" id="status-dot"></div>
                        <span id="status-text">Connected</span>
                        <span class="auto-refresh-indicator" id="refresh-indicator">• Auto-refresh</span>
                    </div>
                    <div class="expires-in" id="expires-in"></div>
                </div>
                
                <div id="message-area">
                    <div id="no-message" class="info-text" style="text-align: center; padding: 2rem;">
                        No messages yet. Send the first message!
                    </div>
                    <div id="message-display" class="hidden">
                        <div class="message-meta" id="message-meta"></div>
                        <div class="message-box received" id="message-content"></div>
                        <button class="copy-btn" onclick="copyMessage()">Copy Message</button>
                    </div>
                    <div id="waiting-display" class="hidden" style="text-align: center; padding: 2rem;">
                        <p class="info-text">⏳ Waiting for reply...</p>
                        <p class="info-text" style="font-size: 0.8rem; margin-top: 0.5rem;">Auto-refreshing every 10 seconds...</p>
                    </div>
                </div>
                
                <div id="reply-area" style="margin-top: 1.5rem;">
                    <textarea id="reply-input" class="chat-focus" placeholder="Type your reply..."></textarea>
                    <p class="warning" style="font-size: 0.8rem;">⚠️ Sending will destroy the current message above</p>
                    <button id="send-btn" class="btn-chat" onclick="sendMessage()">Send Message</button>
                </div>
            </div>
            
            <div class="button-group">
                <button class="btn-secondary" onclick="refreshChat()">🔄 Refresh</button>
                <button class="btn-danger" onclick="destroyChat()">🗑️ Destroy Chat</button>
            </div>
        </div>
        
        <!-- ERROR MODE -->
        <div id="error-mode" class="hidden">
            <div class="card">
                <p class="error-msg" id="error-message"></p>
                <button onclick="window.location.href='/'">Back to Home</button>
            </div>
        </div>
    </div>
    
    <!-- Custom Modal for Destroy Confirmation -->
    <div id="modal-overlay" class="modal-overlay" onclick="closeModal(event)">
        <div class="modal-content" onclick="event.stopPropagation()">
            <div class="modal-title" id="modal-title">⚠️ Confirm Destroy</div>
            <div class="modal-message" id="modal-message">Are you sure you want to destroy this chat? This cannot be undone.</div>
            <div class="modal-buttons">
                <button class="btn-secondary" onclick="closeModal()">Cancel</button>
                <button class="btn-danger" id="modal-confirm-btn" onclick="confirmDestroyChat()">Destroy</button>
            </div>
        </div>
    </div>
    
    <!-- Alert Modal -->
    <div id="alert-overlay" class="modal-overlay" onclick="closeAlert(event)">
        <div class="modal-content" onclick="event.stopPropagation()">
            <div class="modal-title" id="alert-title">Notice</div>
            <div class="modal-message" id="alert-message"></div>
            <div class="modal-buttons">
                <button class="btn-chat" onclick="closeAlert()">OK</button>
            </div>
        </div>
    </div>
    
    <footer>
        Powered by <a href="https://workers.cloudflare.com" target="_blank">Cloudflare Workers</a> + <a href="https://developers.cloudflare.com/durable-objects/">Durable Objects</a> • <a href="https://github.com/M-Igashi/flashpaper" target="_blank">GitHub</a>
    </footer>

    <script>
        const cryptoApi = window.crypto || window.msCrypto;
        
        // Session ID management
        function getOrCreateSessionId(chatId) {
            const key = 'flashpaper_session_' + chatId;
            let sessionId = localStorage.getItem(key);
            if (!sessionId) {
                const array = new Uint8Array(32);
                cryptoApi.getRandomValues(array);
                sessionId = Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
                localStorage.setItem(key, sessionId);
            }
            return sessionId;
        }
        
        function clearSessionId(chatId) {
            localStorage.removeItem('flashpaper_session_' + chatId);
        }
        
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
        let currentTab = 'note';
        let noteLink = '';
        let chatId = '';
        let encryptionKey = null;
        let encryptionKeyStr = '';
        let userToken = '';
        let sessionId = '';
        let creatorLink = '';
        let shareLink = '';
        let autoRefreshInterval = null;
        
        // Tab switching
        function switchTab(tab) {
            currentTab = tab;
            const title = document.getElementById('main-title');
            const tabNote = document.getElementById('tab-note');
            const tabChat = document.getElementById('tab-chat');
            const noteCreate = document.getElementById('note-create-mode');
            const chatCreate = document.getElementById('chat-create-mode');
            
            if (tab === 'note') {
                title.className = 'note-mode';
                tabNote.className = 'tab active-note';
                tabChat.className = 'tab';
                noteCreate.classList.remove('hidden');
                chatCreate.classList.add('hidden');
                history.replaceState(null, '', '/');
            } else {
                title.className = 'chat-mode';
                tabNote.className = 'tab';
                tabChat.className = 'tab active-chat';
                noteCreate.classList.add('hidden');
                chatCreate.classList.remove('hidden');
                history.replaceState(null, '', '/chat');
            }
        }
        
        // Note functions
        async function createNote() {
            const noteInput = document.getElementById('note-input');
            const ttlSelect = document.getElementById('note-ttl');
            const createBtn = document.getElementById('note-create-btn');
            const result = document.getElementById('note-result');
            const resultLink = document.getElementById('note-result-link');
            
            const plaintext = noteInput.value.trim();
            if (!plaintext) { alert('Please enter a note'); return; }
            
            createBtn.disabled = true;
            createBtn.innerHTML = '<span class="loading"></span> Creating...';
            
            try {
                const key = await generateKey();
                const keyStr = await exportKey(key);
                const ciphertext = await encrypt(plaintext, key);
                
                const response = await fetch('/api/note', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ciphertext, ttl_seconds: parseInt(ttlSelect.value) })
                });
                
                if (!response.ok) throw new Error('Failed to create note');
                
                const data = await response.json();
                noteLink = location.origin + '/view/' + data.id + '#' + keyStr;
                
                resultLink.textContent = noteLink;
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
        
        function copyNoteLink() {
            navigator.clipboard.writeText(noteLink).then(() => {
                event.target.textContent = 'Copied!';
                setTimeout(() => event.target.textContent = 'Copy Link', 2000);
            });
        }
        
        async function revealNote() {
            const revealBtn = document.getElementById('note-reveal-btn');
            const noteDisplay = document.getElementById('note-display');
            const noteContent = document.getElementById('note-content');
            
            revealBtn.disabled = true;
            revealBtn.innerHTML = '<span class="loading"></span> Decrypting...';
            
            try {
                const path = location.pathname;
                const hash = location.hash.substring(1);
                const noteId = path.split('/view/')[1];
                
                const response = await fetch('/api/note/' + noteId);
                const data = await response.json();
                
                if (!data.success) throw new Error(data.error || 'Failed to retrieve note');
                
                const key = await importKey(hash);
                const plaintext = await decrypt(data.ciphertext, key);
                
                noteContent.textContent = plaintext;
                revealBtn.classList.add('hidden');
                document.querySelector('.warning').classList.add('hidden');
                noteDisplay.classList.remove('hidden');
            } catch (error) {
                console.error('Error:', error);
                showError(error.message || 'Failed to decrypt note.');
            }
        }
        
        function copyNoteContent() {
            const content = document.getElementById('note-content').textContent;
            navigator.clipboard.writeText(content).then(() => {
                event.target.textContent = 'Copied!';
                setTimeout(() => event.target.textContent = 'Copy Message', 2000);
            });
        }
        
        // Chat functions
        async function createChat() {
            const initialMessage = document.getElementById('chat-initial-message').value.trim();
            const ttlSelect = document.getElementById('chat-ttl');
            const createBtn = document.getElementById('chat-create-btn');
            const result = document.getElementById('chat-result');
            
            createBtn.disabled = true;
            createBtn.innerHTML = '<span class="loading chat"></span> Creating...';
            
            try {
                encryptionKey = await generateKey();
                encryptionKeyStr = await exportKey(encryptionKey);
                
                // Generate temp chat ID for session
                const tempChatId = Math.random().toString(36).substring(2);
                sessionId = getOrCreateSessionId(tempChatId);
                
                const payload = { 
                    ttl_seconds: parseInt(ttlSelect.value),
                    sessionId: sessionId
                };
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
                userToken = data.creatorToken;
                
                // Update session to use real chat ID
                clearSessionId(tempChatId);
                localStorage.setItem('flashpaper_session_' + chatId, sessionId);
                
                creatorLink = location.origin + '/chat/' + chatId + '#' + encryptionKeyStr + ':' + data.creatorToken;
                shareLink = location.origin + '/chat/' + chatId + '#' + encryptionKeyStr + ':' + data.recipientToken;
                
                document.getElementById('chat-share-link').textContent = shareLink;
                result.classList.add('show');
            } catch (error) {
                console.error('Error:', error);
                alert('Failed to create chat. Please try again.');
            } finally {
                createBtn.disabled = false;
                createBtn.innerHTML = 'Start Secure Chat';
            }
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
        
        async function loadChat() {
            try {
                if (!encryptionKey) {
                    encryptionKey = await importKey(encryptionKeyStr);
                }
                
                const response = await fetch('/api/chat/' + chatId + '?token=' + encodeURIComponent(userToken) + '&sessionId=' + encodeURIComponent(sessionId));
                const data = await response.json();
                
                if (!data.success) {
                    stopAutoRefresh();
                    showError(data.error || 'Chat not found');
                    return;
                }
                
                updateExpiresIn(data.expiresAt);
                
                const noMessage = document.getElementById('no-message');
                const messageDisplay = document.getElementById('message-display');
                const waitingDisplay = document.getElementById('waiting-display');
                const replyArea = document.getElementById('reply-area');
                const statusDot = document.getElementById('status-dot');
                const statusText = document.getElementById('status-text');
                
                if (!data.hasMessage) {
                    noMessage.classList.remove('hidden');
                    messageDisplay.classList.add('hidden');
                    waitingDisplay.classList.add('hidden');
                    replyArea.classList.remove('hidden');
                    statusDot.className = 'status-dot';
                    statusText.textContent = 'Ready';
                } else if (data.isMyMessage) {
                    noMessage.classList.add('hidden');
                    messageDisplay.classList.add('hidden');
                    waitingDisplay.classList.remove('hidden');
                    replyArea.classList.add('hidden');
                    statusDot.className = 'status-dot waiting';
                    statusText.textContent = data.messageRead ? 'Message read' : 'Sent, waiting...';
                } else {
                    noMessage.classList.add('hidden');
                    waitingDisplay.classList.add('hidden');
                    messageDisplay.classList.remove('hidden');
                    replyArea.classList.remove('hidden');
                    statusDot.className = 'status-dot';
                    statusText.textContent = 'New message';
                    
                    const plaintext = await decrypt(data.ciphertext, encryptionKey);
                    document.getElementById('message-content').textContent = plaintext;
                    
                    const msgTime = new Date(data.messageAt).toLocaleString();
                    document.getElementById('message-meta').textContent = 'Received • ' + msgTime;
                }
            } catch (error) {
                console.error('Error:', error);
            }
        }
        
        function updateExpiresIn(expiresAt) {
            const now = Date.now();
            const remaining = expiresAt - now;
            
            if (remaining <= 0) {
                document.getElementById('expires-in').textContent = 'Expired';
                stopAutoRefresh();
                return;
            }
            
            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));
            
            if (hours > 24) {
                document.getElementById('expires-in').textContent = 'Expires in ' + Math.floor(hours / 24) + 'd';
            } else if (hours > 0) {
                document.getElementById('expires-in').textContent = 'Expires in ' + hours + 'h ' + minutes + 'm';
            } else {
                document.getElementById('expires-in').textContent = 'Expires in ' + minutes + 'm';
            }
        }
        
        function startAutoRefresh() {
            if (autoRefreshInterval) return;
            autoRefreshInterval = setInterval(loadChat, 10000);
        }
        
        function stopAutoRefresh() {
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
            }
        }
        
        async function sendMessage() {
            const replyInput = document.getElementById('reply-input');
            const sendBtn = document.getElementById('send-btn');
            const plaintext = replyInput.value.trim();
            
            if (!plaintext) { alert('Please enter a message'); return; }
            
            sendBtn.disabled = true;
            sendBtn.innerHTML = '<span class="loading chat"></span> Sending...';
            
            try {
                const ciphertext = await encrypt(plaintext, encryptionKey);
                
                const response = await fetch('/api/chat/' + chatId + '/message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token: userToken, sessionId: sessionId, ciphertext })
                });
                
                const data = await response.json();
                
                if (!data.success) throw new Error(data.error || 'Failed to send message');
                
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
        
        // Custom Modal Functions (for Twitter/X browser compatibility)
        function showModal() {
            document.getElementById('modal-overlay').classList.add('show');
        }
        
        function closeModal(event) {
            if (event && event.target !== event.currentTarget) return;
            document.getElementById('modal-overlay').classList.remove('show');
        }
        
        function showAlert(message, title = 'Notice', callback = null) {
            document.getElementById('alert-title').textContent = title;
            document.getElementById('alert-message').textContent = message;
            window.alertCallback = callback;
            document.getElementById('alert-overlay').classList.add('show');
        }
        
        function closeAlert(event) {
            if (event && event.target !== event.currentTarget) return;
            document.getElementById('alert-overlay').classList.remove('show');
            if (window.alertCallback) {
                window.alertCallback();
                window.alertCallback = null;
            }
        }
        
        // Destroy Chat Functions
        function destroyChat() {
            showModal();
        }
        
        async function confirmDestroyChat() {
            closeModal();
            
            try {
                stopAutoRefresh();
                
                const response = await fetch('/api/chat/' + chatId + '?token=' + encodeURIComponent(userToken) + '&sessionId=' + encodeURIComponent(sessionId), {
                    method: 'DELETE'
                });
                
                const data = await response.json();
                
                if (!data.success) throw new Error(data.error || 'Failed to destroy chat');
                
                // Clear session ID
                clearSessionId(chatId);
                
                showAlert('Chat destroyed successfully.', '✅ Success', function() {
                    window.location.href = '/chat';
                });
            } catch (error) {
                console.error('Error:', error);
                showAlert('Failed to destroy chat: ' + error.message, '❌ Error');
            }
        }
        
        function showError(message) {
            stopAutoRefresh();
            document.getElementById('tabs').classList.add('hidden');
            document.getElementById('note-create-mode').classList.add('hidden');
            document.getElementById('note-view-mode').classList.add('hidden');
            document.getElementById('chat-create-mode').classList.add('hidden');
            document.getElementById('chat-session-mode').classList.add('hidden');
            document.getElementById('error-mode').classList.remove('hidden');
            document.getElementById('error-message').textContent = message;
        }
        
        // Initialize
        (function init() {
            const path = location.pathname;
            const hash = location.hash.substring(1);
            
            if (path.startsWith('/view/')) {
                document.getElementById('tabs').classList.add('hidden');
                document.getElementById('note-create-mode').classList.add('hidden');
                document.getElementById('note-view-mode').classList.remove('hidden');
                document.getElementById('main-title').className = 'note-mode';
            } else if (path.match(/^\\/chat\\/[^/]+$/)) {
                document.getElementById('tabs').classList.add('hidden');
                document.getElementById('note-create-mode').classList.add('hidden');
                document.getElementById('chat-session-mode').classList.remove('hidden');
                document.getElementById('main-title').className = 'chat-mode';
                
                chatId = path.split('/chat/')[1];
                if (hash) {
                    const parts = hash.split(':');
                    if (parts.length === 2) {
                        encryptionKeyStr = parts[0];
                        userToken = parts[1];
                        sessionId = getOrCreateSessionId(chatId);
                        loadChat();
                        startAutoRefresh();
                    } else {
                        showError('Invalid chat link');
                    }
                } else {
                    showError('Invalid chat link - missing key');
                }
            } else if (path === '/chat' || path === '/chat/new') {
                switchTab('chat');
            } else {
                switchTab('note');
            }
            
            window.addEventListener('beforeunload', stopAutoRefresh);
        })();
    </script>
    <!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "{{CF_ANALYTICS_TOKEN}}"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>`;
