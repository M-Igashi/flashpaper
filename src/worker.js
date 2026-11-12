import { DurableObject } from 'cloudflare:workers';

const encoder = new TextEncoder();

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
      let match;

      // ===== NOTE API =====
      if (method === 'POST' && path === '/api/note') {
        const body = await readJson(request);
        if (!body) {
          response = badRequest('Invalid JSON body');
        } else if (!isValidCiphertext(body.ciphertext)) {
          response = badRequest('Invalid ciphertext');
        } else {
          const id = generateId();
          response = await doFetch(env.NOTE_STORE, id, '/store', {
            method: 'POST',
            body: JSON.stringify({ id, ciphertext: body.ciphertext, ttl_seconds: body.ttl_seconds }),
          });
          if (response.ok) {
            ctx.waitUntil(doFetch(env.STATS_STORE, 'global', '/record', { method: 'POST' }));
          }
        }

      } else if (method === 'GET' && (match = path.match(NOTE_ROUTE))) {
        response = await doFetch(env.NOTE_STORE, match[1], '/retrieve');

      // ===== CHAT API =====
      } else if (method === 'POST' && path === '/api/chat') {
        const body = await readJson(request);
        if (!body) {
          response = badRequest('Invalid JSON body');
        } else if (!isShortString(body.sessionId)) {
          response = badRequest('Invalid session ID');
        } else if (body.ciphertext != null && !isValidCiphertext(body.ciphertext)) {
          response = badRequest('Invalid ciphertext');
        } else {
          const id = generateId();
          response = await doFetch(env.CHAT_STORE, id, '/create', {
            method: 'POST',
            body: JSON.stringify({
              id,
              creatorToken: generateToken(),
              recipientToken: generateToken(),
              creatorSessionId: body.sessionId,
              ttl_seconds: body.ttl_seconds,
              initialMessage: body.ciphertext
            }),
          });
          if (response.ok) {
            ctx.waitUntil(doFetch(env.STATS_STORE, 'global', '/record-chat', { method: 'POST' }));
          }
        }

      } else if (method === 'GET' && (match = path.match(CHAT_ROUTE))) {
        const token = url.searchParams.get('token');
        const sessionId = url.searchParams.get('sessionId');

        if (!token) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else if (!sessionId) {
          response = Response.json({ success: false, error: 'Session ID required' }, { status: 401 });
        } else {
          response = await doFetch(env.CHAT_STORE, match[1], '/get?token=' + encodeURIComponent(token) + '&sessionId=' + encodeURIComponent(sessionId));
        }

      } else if (method === 'POST' && (match = path.match(CHAT_MESSAGE_ROUTE))) {
        const body = await readJson(request);

        if (!body) {
          response = badRequest('Invalid JSON body');
        } else if (!isShortString(body.token)) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else if (!isShortString(body.sessionId)) {
          response = Response.json({ success: false, error: 'Session ID required' }, { status: 401 });
        } else if (!isValidCiphertext(body.ciphertext)) {
          response = badRequest('Invalid ciphertext');
        } else {
          response = await doFetch(env.CHAT_STORE, match[1], '/message', {
            method: 'POST',
            body: JSON.stringify({
              token: body.token,
              sessionId: body.sessionId,
              ciphertext: body.ciphertext
            }),
          });
        }

      } else if (method === 'DELETE' && (match = path.match(CHAT_ROUTE))) {
        const token = url.searchParams.get('token');
        const sessionId = url.searchParams.get('sessionId');

        if (!token) {
          response = Response.json({ success: false, error: 'Token required' }, { status: 401 });
        } else {
          response = await doFetch(env.CHAT_STORE, match[1], '/destroy?token=' + encodeURIComponent(token) + '&sessionId=' + encodeURIComponent(sessionId || ''), {
            method: 'DELETE'
          });
        }

      // ===== STATS API =====
      } else if (method === 'GET' && path === '/api/stats') {
        response = await doFetch(env.STATS_STORE, 'global', '/stats');

      // ===== STATIC FILES (R2) =====
      } else if (method === 'GET' && STATIC_FILES[path]) {
        const object = await env.SITE_BUCKET.get(path.slice(1));
        response = object
          ? new Response(object.body, { headers: { 'Content-Type': STATIC_FILES[path] } })
          : new Response('Not Found', { status: 404 });

      // ===== HTML PAGES =====
      } else if (method === 'GET' && (path === '/' || path === '/index.html' || path === '/chat' || path === '/chat/new' || path.startsWith('/view/') || path.match(/^\/chat\/[^\/]+$/))) {
        const analyticsToken = env.CF_ANALYTICS_TOKEN || '';
        let html = HTML_CONTENT;
        
        // Generate SEO meta tags based on path
        const baseUrl = 'https://flashpaper.ravers.workers.dev';
        const isMainPage = path === '/' || path === '/index.html';
        const isChatLanding = path === '/chat';
        const isIndexable = isMainPage || isChatLanding;
        const canonicalUrl = isChatLanding ? `${baseUrl}/chat` : `${baseUrl}/`;
        const pageTitle = isChatLanding
          ? 'Flashpaper Chat - Self-Destructing Encrypted Chat'
          : 'Flashpaper - Self-Destructing Encrypted Note/Chat';
        const pageDescription = isChatLanding
          ? 'Create an end-to-end encrypted, self-destructing chat room. No accounts, no tracking, messages vanish after reading.'
          : 'Share end-to-end encrypted, self-destructing notes and chats. No accounts, no tracking, content vanishes after reading.';
        let seoMetaTags = `<link rel="canonical" href="${canonicalUrl}">`;
        seoMetaTags += `\n    <meta name="description" content="${pageDescription}">`;
        seoMetaTags += `\n    <title>${pageTitle}</title>`;
        if (!isIndexable) {
          seoMetaTags += '\n    <meta name="robots" content="noindex, nofollow">';
        }
        html = html.replace('{{SEO_META_TAGS}}', seoMetaTags);
        
        if (analyticsToken) {
          html = html.replace('{{CF_ANALYTICS_TOKEN}}', analyticsToken);
        } else {
          html = html.replace(/<!-- Cloudflare Web Analytics -->.*<!-- End Cloudflare Web Analytics -->/s, '');
        }
        return new Response(html, { headers: HTML_HEADERS });
        
      } else {
        response = new Response('Not Found', { status: 404 });
      }

      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      if (path.startsWith('/api/')) newHeaders.set('Cache-Control', 'no-store');
      
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
      
    } catch (error) {
      console.error(JSON.stringify({ message: 'unhandled error', error: error instanceof Error ? error.message : String(error), path }));
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
  },
};

const MAX_CIPHERTEXT_LENGTH = 1_000_000;
const MAX_BODY_BYTES = MAX_CIPHERTEXT_LENGTH + 10_000;
const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;

const ID = '[a-z0-9]{8,64}';
const NOTE_ROUTE = new RegExp(`^/api/note/(${ID})$`);
const CHAT_ROUTE = new RegExp(`^/api/chat/(${ID})$`);
const CHAT_MESSAGE_ROUTE = new RegExp(`^/api/chat/(${ID})/message$`);

const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; img-src data:; script-src 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'unsafe-inline'; connect-src 'self' https://cloudflareinsights.com; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

const STATIC_FILES = {
  '/google174732a25afed9fc.html': 'text/html; charset=utf-8',
  '/sitemap.xml': 'application/xml; charset=utf-8',
  '/robots.txt': 'text/plain; charset=utf-8',
};

function doFetch(binding, name, path, init) {
  return binding.get(binding.idFromName(name)).fetch('https://do' + path, init);
}

function generateId() {
  return randomHex(16);
}

// For comparing hashed values only (fixed-length strings)
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function toHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function randomHex(byteLength) {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

function generateToken() {
  return randomHex(24);
}

async function readJson(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY_BYTES) return null;
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

function badRequest(error) {
  return Response.json({ success: false, error }, { status: 400 });
}

function isShortString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isValidCiphertext(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CIPHERTEXT_LENGTH;
}

function ttlMs(ttlSeconds, defaultSeconds) {
  const seconds = Number.isFinite(ttlSeconds) && ttlSeconds > 0
    ? Math.min(ttlSeconds, MAX_TTL_SECONDS)
    : defaultSeconds;
  return seconds * 1000;
}

// Leaves no trace of the Durable Object once its content is gone
async function wipeStorage(storage) {
  await storage.deleteAlarm();
  await storage.deleteAll();
}

async function hashToken(token) {
  if (!token) return null;
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return toHex(new Uint8Array(hashBuffer));
}

// ===== NOTE STORE =====
export class NoteStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // Created per request because wipeStorage() drops the table
  ensureTable() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        ciphertext TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    this.ensureTable();

    if (path === '/store') {
      const { id, ciphertext, ttl_seconds } = await request.json();

      const now = Date.now();
      const expiresAt = now + ttlMs(ttl_seconds, MAX_TTL_SECONDS);

      this.sql.exec(
        `INSERT INTO notes (id, ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        id, ciphertext, now, expiresAt
      );
      await this.ctx.storage.setAlarm(expiresAt);

      return Response.json({ id });

    } else if (path === '/retrieve') {
      const note = this.sql.exec(`SELECT * FROM notes LIMIT 1`).toArray()[0];
      await wipeStorage(this.ctx.storage);

      if (!note) {
        return Response.json({ success: false, error: 'Note not found or already read' });
      }
      if (note.expires_at && Date.now() > note.expires_at) {
        return Response.json({ success: false, error: 'Note has expired' });
      }

      return Response.json({ success: true, ciphertext: note.ciphertext });
    }

    return new Response('Not Found', { status: 404 });
  }

  async alarm() {
    await wipeStorage(this.ctx.storage);
  }
}

// ===== CHAT STORE =====
export class ChatStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // Created per request because wipeStorage() drops the table
  ensureTable() {
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
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    this.ensureTable();

    if (path === '/create') {
      const body = await request.json();
      const { id, creatorToken, recipientToken, creatorSessionId, ttl_seconds, initialMessage } = body;

      const now = Date.now();
      const expiresAt = now + ttlMs(ttl_seconds, 24 * 60 * 60);

      const [creatorHash, recipientHash, creatorSessionHash] = await Promise.all([
        hashToken(creatorToken),
        hashToken(recipientToken),
        hashToken(creatorSessionId),
      ]);

      this.sql.exec(
        `INSERT INTO chats (id, creator_token_hash, recipient_token_hash, creator_session_hash, recipient_session_hash, created_at, expires_at, current_message, current_sender, message_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        id, creatorHash, recipientHash, creatorSessionHash, now, expiresAt,
        initialMessage || null,
        initialMessage ? 'creator' : null,
        initialMessage ? now : null
      );
      await this.ctx.storage.setAlarm(expiresAt);

      return Response.json({
        success: true,
        id,
        creatorToken,
        recipientToken,
        expiresAt
      });

    } else if (path === '/get') {
      const [tokenHash, sessionHash] = await Promise.all([
        hashToken(url.searchParams.get('token')),
        hashToken(url.searchParams.get('sessionId')),
      ]);

      const { chat, role, sessionCol, error } = await this.authorize(tokenHash, sessionHash);
      if (error) return error;

      // Bind session on first access
      if (!chat[sessionCol]) {
        this.sql.exec(`UPDATE chats SET ${sessionCol} = ? WHERE id = ?`, sessionHash, chat.id);
      }

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
      const [tokenHash, sessionHash] = await Promise.all([
        hashToken(body.token),
        hashToken(body.sessionId),
      ]);

      const { chat, role, error } = await this.authorize(tokenHash, sessionHash);
      if (error) return error;

      const now = Date.now();
      this.sql.exec(
        `UPDATE chats SET current_message = ?, current_sender = ?, message_at = ?, message_read = 0 WHERE id = ?`,
        body.ciphertext, role, now, chat.id
      );

      return Response.json({ success: true, messageAt: now });

    } else if (path === '/destroy') {
      const [tokenHash, sessionHash] = await Promise.all([
        hashToken(url.searchParams.get('token')),
        hashToken(url.searchParams.get('sessionId')),
      ]);

      const { chat, error } = await this.authorize(tokenHash, sessionHash);
      if (error) return error;

      await wipeStorage(this.ctx.storage);

      return Response.json({ success: true, message: 'Chat destroyed' });
    }

    return new Response('Not Found', { status: 404 });
  }

  // Returns { chat, role, sessionCol } on success, { error: Response } on failure.
  // Session check is skipped when sessionHash is null (destroy without sessionId).
  async authorize(tokenHash, sessionHash) {
    const chat = this.sql.exec(`SELECT * FROM chats LIMIT 1`).toArray()[0];
    if (!chat) {
      await wipeStorage(this.ctx.storage);
      return { error: Response.json({ success: false, error: 'Chat not found or expired' }) };
    }

    if (Date.now() > chat.expires_at) {
      await wipeStorage(this.ctx.storage);
      return { error: Response.json({ success: false, error: 'Chat has expired' }) };
    }

    const isCreator = timingSafeEqual(tokenHash, chat.creator_token_hash);
    const isRecipient = timingSafeEqual(tokenHash, chat.recipient_token_hash);
    if (!isCreator && !isRecipient) {
      return { error: Response.json({ success: false, error: 'Invalid token' }, { status: 401 }) };
    }

    const sessionCol = isCreator ? 'creator_session_hash' : 'recipient_session_hash';
    if (sessionHash && chat[sessionCol] && !timingSafeEqual(chat[sessionCol], sessionHash)) {
      return { error: Response.json({ success: false, error: 'Session mismatch - this chat is bound to another browser' }, { status: 403 }) };
    }

    return { chat, role: isCreator ? 'creator' : 'recipient', sessionCol };
  }

  async alarm() {
    await wipeStorage(this.ctx.storage);
  }
}

// ===== STATS STORE =====
export class StatsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS stats (
          date TEXT PRIMARY KEY,
          note_count INTEGER NOT NULL DEFAULT 0,
          chat_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Legacy schema migration (note-only 'count' column); no-ops once migrated
      try { this.sql.exec(`ALTER TABLE stats RENAME COLUMN count TO note_count`); } catch (e) {}
      try { this.sql.exec(`ALTER TABLE stats ADD COLUMN chat_count INTEGER NOT NULL DEFAULT 0`); } catch (e) {}
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'POST' && (path === '/record' || path === '/record-chat')) {
      const isNote = path === '/record';
      const today = new Date().toISOString().split('T')[0];
      this.sql.exec(`
        INSERT INTO stats (date, note_count, chat_count) VALUES (?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          note_count = note_count + excluded.note_count,
          chat_count = chat_count + excluded.chat_count
      `, today, isNote ? 1 : 0, isNote ? 0 : 1);
      return Response.json({ success: true });

    } else if (path === '/stats') {
      const now = new Date();
      const daysAgo = n => {
        const d = new Date(now);
        d.setDate(d.getDate() - n);
        return d.toISOString().split('T')[0];
      };
      const periods = { last_24h: daysAgo(1), last_7d: daysAgo(7), last_30d: daysAgo(30), last_365d: daysAgo(365), all_time: null };

      const notes = {}, chats = {};
      for (const [label, since] of Object.entries(periods)) {
        const row = this.sql.exec(
          `SELECT COALESCE(SUM(note_count), 0) as notes, COALESCE(SUM(chat_count), 0) as chats FROM stats` + (since ? ` WHERE date >= ?` : ''),
          ...(since ? [since] : [])
        ).toArray()[0];
        notes[label] = Number(row.notes);
        chats[label] = Number(row.chats);
      }
      const dailyStats = this.sql.exec(`SELECT date, note_count, chat_count FROM stats WHERE date >= ? ORDER BY date ASC`, periods.last_30d).toArray();

      return Response.json({
        notes,
        chats,
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
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="theme-color" content="#0a0a0b">
    <meta name="color-scheme" content="dark">
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%230a0a0b'/%3E%3Cpath fill='%23ff6a2b' d='M12.4 3c.7 2.9-.9 4.6-2.4 6.2C8.6 10.7 7 12.4 7 15.2a5 5 0 0 0 10 0c0-1.9-.8-3.3-1.8-4.3-.4 1.4-1.2 2-1.9 2.1.5-3 .1-6.6-.9-10z'/%3E%3C/svg%3E">
    {{SEO_META_TAGS}}
    <style>
        :root {
            --bg: #0a0a0b;
            --surface: #141416;
            --surface-2: #1c1c20;
            --line: #2c2c33;
            --text: #f4f4f5;
            --muted: #a1a1aa;
            --note: #ff6a2b;
            --note-2: #ffb347;
            --chat: #7c9bff;
            --chat-2: #9fe3ff;
            --danger: #ff5a5f;
            --ok: #4ade80;
            --accent: var(--note);
            --accent-2: var(--note-2);
            --on-accent: #0a0a0b;
            --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
            --radius: 16px;
        }

        body[data-mode="chat"] { --accent: var(--chat); --accent-2: var(--chat-2); }

        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }

        html { -webkit-text-size-adjust: 100%; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
            background: var(--bg);
            color: var(--text);
            line-height: 1.5;
            min-height: 100vh;
            min-height: 100dvh;
            overflow-x: hidden;
        }

        body::before {
            content: "";
            position: fixed;
            inset: -30vh -20vw auto -20vw;
            height: 70vh;
            background: radial-gradient(ellipse at 50% 0%, var(--accent), transparent 62%);
            opacity: 0.16;
            pointer-events: none;
            transition: background 0.4s;
            z-index: 0;
        }

        .app {
            position: relative;
            z-index: 1;
            max-width: 560px;
            margin: 0 auto;
            padding: env(safe-area-inset-top) max(16px, env(safe-area-inset-right)) 0 max(16px, env(safe-area-inset-left));
            min-height: 100vh;
            min-height: 100dvh;
            display: flex;
            flex-direction: column;
        }

        .hidden { display: none !important; }

        /* Top bar */
        .top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 0 12px;
        }

        .brand {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            color: var(--text);
            text-decoration: none;
            font-family: var(--mono);
            font-weight: 700;
            font-size: 0.95rem;
            letter-spacing: 0.18em;
        }

        .brand svg { width: 22px; height: 22px; fill: var(--accent); transition: fill 0.3s; }

        .badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            font-family: var(--mono);
            font-size: 0.7rem;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--muted);
            border: 1px solid var(--line);
            border-radius: 999px;
            padding: 5px 10px;
            white-space: nowrap;
        }

        .badge-short { display: none; }

        @media (max-width: 379px) {
            .badge-long { display: none; }
            .badge-short { display: inline; }
        }

        .badge::before {
            content: "";
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--ok);
            box-shadow: 0 0 8px var(--ok);
        }

        /* Segmented tabs */
        .seg {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            padding: 4px;
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: 14px;
            margin-bottom: 20px;
        }

        .seg button {
            min-height: 44px;
            border: 0;
            border-radius: 10px;
            background: transparent;
            color: var(--muted);
            font: inherit;
            font-weight: 600;
            font-size: 0.95rem;
            cursor: pointer;
            transition: background 0.2s, color 0.2s;
        }

        .seg button[aria-selected="true"] { background: var(--accent); color: var(--on-accent); }

        main { flex: 1; display: flex; flex-direction: column; }

        .view { flex: 1; display: flex; flex-direction: column; animation: rise 0.35s ease both; }

        @keyframes rise {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: none; }
        }

        .headline {
            font-size: clamp(1.75rem, 7.4vw, 2.6rem);
            line-height: 1.08;
            font-weight: 800;
            letter-spacing: -0.035em;
            margin-bottom: 18px;
        }

        .headline em {
            font-style: normal;
            background: linear-gradient(100deg, var(--accent), var(--accent-2));
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
        }

        .lead { color: var(--muted); font-size: 1rem; margin-bottom: 20px; }

        /* Fields */
        .field {
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: var(--radius);
            transition: border-color 0.2s, box-shadow 0.2s;
        }

        .field:focus-within {
            border-color: var(--accent);
            box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
        }

        textarea {
            display: block;
            width: 100%;
            min-height: 168px;
            background: transparent;
            border: 0;
            outline: 0;
            color: var(--text);
            font: inherit;
            font-size: 1.0625rem;
            line-height: 1.5;
            padding: 16px;
            resize: none;
        }

        textarea::placeholder { color: #71717a; }

        .field-foot {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            padding: 10px 16px 12px;
            border-top: 1px solid var(--line);
            font-family: var(--mono);
            font-size: 0.72rem;
            color: var(--muted);
        }

        /* TTL chips */
        .chips { border: 0; margin-top: 18px; }

        .chips legend, .label {
            font-family: var(--mono);
            font-size: 0.72rem;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
            margin-bottom: 8px;
        }

        .chip-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }

        .chip-row input { position: absolute; opacity: 0; pointer-events: none; }

        .chip-row label {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 48px;
            border: 1px solid var(--line);
            border-radius: 12px;
            background: var(--surface);
            color: var(--muted);
            font-weight: 600;
            font-size: 0.95rem;
            cursor: pointer;
            transition: border-color 0.2s, color 0.2s, background 0.2s;
        }

        .chip-row input:checked + label {
            border-color: var(--accent);
            color: var(--accent);
            background: color-mix(in srgb, var(--accent) 10%, var(--surface));
        }

        .chip-row input:focus-visible + label { outline: 2px solid var(--accent); outline-offset: 2px; }

        /* Buttons */
        .btn {
            position: relative;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            width: 100%;
            min-height: 54px;
            padding: 0 14px;
            white-space: nowrap;
            border: 1px solid transparent;
            border-radius: 14px;
            background: var(--accent);
            color: var(--on-accent);
            font: inherit;
            font-weight: 700;
            font-size: 1.0625rem;
            cursor: pointer;
            transition: transform 0.1s, filter 0.2s, background 0.2s;
        }

        .btn:active { transform: scale(0.98); }
        .btn:hover { filter: brightness(1.08); }
        .btn:disabled { cursor: not-allowed; filter: saturate(0.6) brightness(0.8); }
        .btn:focus-visible, .seg button:focus-visible, .send:focus-visible, .linkbox:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

        .btn.ghost { background: var(--surface); border-color: var(--line); color: var(--text); }
        .btn.quiet { background: transparent; color: var(--muted); min-height: 48px; font-weight: 600; font-size: 0.95rem; }
        .btn.danger { background: var(--danger); color: #0a0a0b; }
        .btn.danger-ghost { background: transparent; border-color: var(--line); color: var(--danger); }
        .btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; flex: none; }

        .btn.busy { color: transparent !important; }
        .btn.busy::after {
            content: "";
            position: absolute;
            width: 20px;
            height: 20px;
            border: 2.5px solid rgba(10, 10, 11, 0.3);
            border-top-color: #0a0a0b;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }

        @keyframes spin { to { transform: rotate(360deg); } }

        .row { display: flex; gap: 8px; }
        .row .btn { flex: 1; }
        .share-btn { display: none; }
        .can-share .share-btn { display: inline-flex; }

        /* Sticky call to action */
        .cta {
            position: sticky;
            bottom: 0;
            z-index: 5;
            margin-top: 18px;
            padding: 12px 0 calc(12px + env(safe-area-inset-bottom));
            background: linear-gradient(to top, var(--bg) 72%, transparent);
        }

        /* Result panel */
        .result { animation: rise 0.35s ease both; }

        .result-head {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 1.5rem;
            font-weight: 800;
            letter-spacing: -0.02em;
            margin-bottom: 6px;
        }

        .check {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 30px;
            height: 30px;
            border-radius: 50%;
            background: var(--accent);
            color: var(--on-accent);
            font-size: 1rem;
            flex: none;
        }

        .linkbox {
            display: block;
            width: 100%;
            text-align: left;
            font-family: var(--mono);
            font-size: 0.85rem;
            line-height: 1.55;
            color: var(--text);
            word-break: break-all;
            -webkit-user-select: all;
            user-select: all;
            background: var(--surface);
            border: 1px dashed color-mix(in srgb, var(--accent) 60%, var(--line));
            border-radius: var(--radius);
            padding: 14px 16px;
            margin-bottom: 12px;
            cursor: pointer;
        }

        .stack > * + * { margin-top: 8px; }

        /* How it works */
        details.facts {
            margin: 22px 0 8px;
            border: 1px solid var(--line);
            border-radius: var(--radius);
            background: var(--surface);
        }

        details.facts summary {
            list-style: none;
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 52px;
            padding: 0 16px;
            font-weight: 600;
            cursor: pointer;
        }

        details.facts summary::-webkit-details-marker { display: none; }
        details.facts summary::after { content: "+"; font-family: var(--mono); font-size: 1.2rem; color: var(--accent); }
        details.facts[open] summary::after { content: "−"; }

        details.facts ol { list-style: none; padding: 0 16px 16px; counter-reset: step; }

        details.facts li {
            counter-increment: step;
            position: relative;
            padding: 8px 0 8px 36px;
            color: var(--muted);
            font-size: 0.95rem;
        }

        details.facts li::before {
            content: counter(step);
            position: absolute;
            left: 0;
            top: 8px;
            width: 24px;
            height: 24px;
            border-radius: 50%;
            border: 1px solid var(--accent);
            color: var(--accent);
            font-family: var(--mono);
            font-size: 0.75rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        /* Gate, empty, and error states */
        .gate { flex: 1; display: flex; flex-direction: column; justify-content: center; padding: 24px 0; }

        .glyph {
            width: 72px;
            height: 72px;
            border-radius: 22px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: color-mix(in srgb, var(--accent) 14%, var(--surface));
            border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
            margin-bottom: 20px;
        }

        .glyph svg { width: 36px; height: 36px; fill: var(--accent); }
        .glyph.flicker svg { animation: flicker 2.4s ease-in-out infinite; transform-origin: 50% 90%; }
        .glyph.danger { background: color-mix(in srgb, var(--danger) 14%, var(--surface)); border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
        .glyph.danger svg { fill: none; stroke: var(--danger); stroke-width: 2; stroke-linecap: round; }

        @keyframes flicker {
            0%, 100% { transform: scale(1) rotate(-1deg); }
            40% { transform: scale(1.07, 1.1) rotate(2deg); }
            70% { transform: scale(0.97, 1.03) rotate(-2deg); }
        }

        .burned {
            display: flex;
            align-items: center;
            gap: 10px;
            font-size: 0.9rem;
            font-weight: 600;
            color: var(--accent);
            background: color-mix(in srgb, var(--accent) 10%, var(--surface));
            border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
            border-radius: 12px;
            padding: 12px 14px;
            margin-bottom: 12px;
        }

        .burned svg { width: 18px; height: 18px; fill: currentColor; flex: none; }

        .message {
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: var(--radius);
            padding: 18px 16px;
            font-size: 1.0625rem;
            line-height: 1.6;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            margin-bottom: 12px;
            animation: reveal 0.6s ease both;
        }

        @keyframes reveal {
            from { opacity: 0; filter: blur(8px); }
            to { opacity: 1; filter: none; }
        }

        /* Chat session */
        .statusbar {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 44px;
            padding: 0 14px;
            background: var(--surface);
            border: 1px solid var(--line);
            border-radius: 12px;
            font-size: 0.9rem;
            font-weight: 600;
            margin-bottom: 16px;
        }

        .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 8px var(--ok); flex: none; }
        .dot.waiting { background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: pulse 1.6s ease-in-out infinite; }
        .dot.error { background: var(--danger); box-shadow: 0 0 8px var(--danger); }

        @keyframes pulse { 50% { opacity: 0.35; } }

        .spacer { flex: 1; }
        #expires-in { font-family: var(--mono); font-size: 0.75rem; font-weight: 400; color: var(--muted); white-space: nowrap; }

        .stage { flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 180px; }

        .empty { text-align: center; color: var(--muted); padding: 24px 0; }
        .empty strong { display: block; color: var(--text); font-size: 1.15rem; margin-bottom: 4px; }

        .rings { position: relative; width: 56px; height: 56px; margin: 0 auto 18px; }
        .rings::before, .rings::after {
            content: "";
            position: absolute;
            inset: 0;
            border-radius: 50%;
            border: 2px solid var(--accent);
            animation: ring 2.4s ease-out infinite;
        }
        .rings::after { animation-delay: 1.2s; }

        @keyframes ring {
            from { transform: scale(0.3); opacity: 1; }
            to { transform: scale(1); opacity: 0; }
        }

        .meta { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; }

        #message-display .message { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); border-radius: 4px 18px 18px 18px; }

        .composer-wrap {
            position: sticky;
            bottom: 0;
            z-index: 5;
            padding: 12px 0 8px;
            background: linear-gradient(to top, var(--bg) 80%, transparent);
        }

        .composer { display: flex; align-items: flex-end; gap: 8px; padding: 6px 6px 6px 4px; border-radius: 26px; }
        .composer textarea { min-height: 44px; max-height: 40vh; padding: 10px 12px; }

        .send {
            flex: none;
            width: 44px;
            height: 44px;
            border: 0;
            border-radius: 50%;
            background: var(--accent);
            color: var(--on-accent);
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: transform 0.1s, filter 0.2s;
        }

        .send:active { transform: scale(0.94); }
        .send:disabled { filter: saturate(0.5) brightness(0.7); }
        .send svg { width: 22px; height: 22px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }

        .hint { font-size: 0.8rem; color: var(--muted); text-align: center; margin-top: 8px; }

        .chat-actions { display: flex; gap: 8px; padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
        .chat-actions .btn { flex: 1; min-height: 46px; font-size: 0.9rem; font-weight: 600; }

        /* Sheets */
        .overlay {
            position: fixed;
            inset: 0;
            z-index: 100;
            display: flex;
            align-items: flex-end;
            justify-content: center;
            background: rgba(0, 0, 0, 0.7);
            -webkit-backdrop-filter: blur(6px);
            backdrop-filter: blur(6px);
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s, visibility 0.2s;
        }

        .overlay.show { opacity: 1; visibility: visible; }

        .sheet {
            width: 100%;
            max-width: 480px;
            background: var(--surface-2);
            border: 1px solid var(--line);
            border-bottom: 0;
            border-radius: 24px 24px 0 0;
            padding: 12px 20px calc(20px + env(safe-area-inset-bottom));
            transform: translateY(100%);
            transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        .overlay.show .sheet { transform: none; }
        .sheet::before { content: ""; display: block; width: 40px; height: 4px; border-radius: 2px; background: var(--line); margin: 0 auto 18px; }
        .sheet-title { font-size: 1.25rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 6px; }
        .sheet-text { color: var(--muted); margin-bottom: 20px; }

        /* Toast */
        .toast {
            position: fixed;
            left: 50%;
            bottom: calc(96px + env(safe-area-inset-bottom));
            z-index: 200;
            transform: translate(-50%, 12px);
            width: max-content;
            max-width: calc(100vw - 32px);
            text-align: center;
            background: var(--text);
            color: var(--bg);
            font-weight: 600;
            font-size: 0.9rem;
            padding: 10px 16px;
            border-radius: 18px;
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.2s, transform 0.2s;
        }

        .toast.show { opacity: 1; transform: translate(-50%, 0); }

        footer {
            padding: 16px 0 calc(20px + env(safe-area-inset-bottom));
            color: #71717a;
            font-size: 0.78rem;
            text-align: center;
        }

        footer a { color: var(--muted); text-decoration: none; padding: 8px 2px; }
        footer a:hover { color: var(--text); }

        @media (min-width: 600px) {
            .top { padding-top: 28px; }
            .seg { margin-bottom: 32px; }
            .overlay { align-items: center; }
            .sheet { border-bottom: 1px solid var(--line); border-radius: 24px; padding-bottom: 20px; transform: scale(0.95); }
            .sheet::before { display: none; }
            .sheet { padding-top: 24px; }
            textarea { min-height: 200px; }
            .composer textarea { min-height: 44px; }
        }

        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
        }
    </style>
</head>
<body data-mode="note">
    <div class="app">
        <header class="top">
            <a class="brand" href="/" aria-label="Flashpaper home">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.4 2c.8 3.3-1 5.2-2.7 7C8.1 10.700 6 12.700 6 15.800a6 6 0 0 0 12 0c0-2.200-.9-3.800-2.100-5-.5 1.600-1.400 2.300-2.200 2.400.6-3.400.100-7.400-1.300-11.200z"/></svg>
                <span>FLASHPAPER</span>
            </a>
            <span class="badge"><span class="badge-long">End-to-end encrypted</span><span class="badge-short">E2E encrypted</span></span>
        </header>

        <nav class="seg" id="tabs" role="tablist" aria-label="Mode">
            <button type="button" role="tab" id="tab-note" aria-selected="true" onclick="switchTab('note')">Note</button>
            <button type="button" role="tab" id="tab-chat" aria-selected="false" onclick="switchTab('chat')">Chat</button>
        </nav>

        <main>
            <!-- NOTE CREATE MODE -->
            <section id="note-create-mode" class="view">
                <div id="note-form">
                    <h1 class="headline">Send a secret that <em>burns after reading.</em></h1>
                    <div class="field">
                        <textarea id="note-input" placeholder="Write your secret note…" aria-label="Secret note" autocomplete="off" autocapitalize="sentences" spellcheck="false"></textarea>
                        <div class="field-foot">
                            <span>Encrypted on this device</span>
                            <span id="note-count">0</span>
                        </div>
                    </div>
                    <fieldset class="chips">
                        <legend>Expires after</legend>
                        <div class="chip-row">
                            <input type="radio" name="note-ttl" id="note-ttl-1h" value="3600"><label for="note-ttl-1h">1 hour</label>
                            <input type="radio" name="note-ttl" id="note-ttl-24h" value="86400" checked><label for="note-ttl-24h">24 hours</label>
                            <input type="radio" name="note-ttl" id="note-ttl-7d" value="604800"><label for="note-ttl-7d">7 days</label>
                        </div>
                    </fieldset>
                    <div class="cta">
                        <button type="button" id="note-create-btn" class="btn" onclick="createNote()">Create secret link</button>
                    </div>
                </div>

                <div id="note-result" class="result hidden">
                    <div class="result-head"><span class="check">✓</span>Your link is ready</div>
                    <p class="lead">It opens once. After that, the note is gone for good.</p>
                    <button type="button" class="linkbox" id="note-result-link" onclick="copyText(noteLink)" aria-label="Copy link"></button>
                    <div class="stack">
                        <div class="row">
                            <button type="button" class="btn" onclick="copyText(noteLink)">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>Copy link
                            </button>
                            <button type="button" class="btn ghost share-btn" onclick="shareUrl(noteLink)">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>Share
                            </button>
                        </div>
                        <button type="button" class="btn quiet" onclick="resetNote()">Write another note</button>
                    </div>
                </div>

                <details class="facts">
                    <summary>How it works</summary>
                    <ol>
                        <li>Your note is encrypted in your browser with AES-256-GCM before it leaves this device.</li>
                        <li>The key lives only in the link, after the # sign. It is never sent to the server.</li>
                        <li>The first person to open the link reads the note, and the server deletes it immediately.</li>
                        <li>Unopened notes are deleted when they expire.</li>
                    </ol>
                </details>
            </section>

            <!-- NOTE VIEW MODE -->
            <section id="note-view-mode" class="view hidden">
                <div id="note-gate" class="gate">
                    <div class="glyph flicker"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.4 2c.8 3.3-1 5.2-2.7 7C8.1 10.700 6 12.700 6 15.800a6 6 0 0 0 12 0c0-2.200-.9-3.800-2.100-5-.5 1.600-1.400 2.300-2.200 2.400.6-3.400.100-7.400-1.300-11.200z"/></svg></div>
                    <h1 class="headline">Someone sent you a <em>secret note.</em></h1>
                    <p class="lead">You can open it only once. The moment you reveal it, it is destroyed on the server. Make sure you are ready to read it.</p>
                    <div class="cta">
                        <button type="button" id="note-reveal-btn" class="btn" onclick="revealNote()">Reveal and destroy</button>
                    </div>
                </div>
                <div id="note-display" class="hidden">
                    <div class="burned">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.4 2c.8 3.3-1 5.2-2.7 7C8.1 10.700 6 12.700 6 15.800a6 6 0 0 0 12 0c0-2.200-.9-3.800-2.100-5-.5 1.600-1.400 2.300-2.200 2.400.6-3.400.100-7.400-1.300-11.200z"/></svg>
                        Destroyed on the server. This screen is the only copy.
                    </div>
                    <div id="note-content" class="message"></div>
                    <div class="stack">
                        <button type="button" class="btn" onclick="copyText(document.getElementById('note-content').textContent)">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>Copy note
                        </button>
                        <button type="button" class="btn quiet" onclick="window.location.href='/'">Write your own note</button>
                    </div>
                </div>
            </section>

            <!-- CHAT CREATE MODE -->
            <section id="chat-create-mode" class="view hidden">
                <div id="chat-form">
                    <h1 class="headline">A private chat that <em>leaves no history.</em></h1>
                    <div class="field">
                        <textarea id="chat-initial-message" placeholder="Write your first message (optional)…" aria-label="First message" autocomplete="off" spellcheck="false"></textarea>
                        <div class="field-foot">
                            <span>Encrypted on this device</span>
                            <span>One message at a time</span>
                        </div>
                    </div>
                    <fieldset class="chips">
                        <legend>Chat expires after</legend>
                        <div class="chip-row">
                            <input type="radio" name="chat-ttl" id="chat-ttl-1h" value="3600"><label for="chat-ttl-1h">1 hour</label>
                            <input type="radio" name="chat-ttl" id="chat-ttl-24h" value="86400" checked><label for="chat-ttl-24h">24 hours</label>
                            <input type="radio" name="chat-ttl" id="chat-ttl-7d" value="604800"><label for="chat-ttl-7d">7 days</label>
                        </div>
                    </fieldset>
                    <div class="cta">
                        <button type="button" id="chat-create-btn" class="btn" onclick="createChat()">Start secure chat</button>
                    </div>
                </div>

                <div id="chat-result" class="result hidden">
                    <div class="result-head"><span class="check">✓</span>Chat created</div>
                    <p class="lead">Step 1: send this invite link to your contact. Step 2: open the chat on this device.</p>
                    <div class="label">Invite link for your contact</div>
                    <button type="button" class="linkbox" id="chat-share-link" onclick="copyText(shareLink)" aria-label="Copy invite link"></button>
                    <div class="stack">
                        <div class="row">
                            <button type="button" class="btn ghost" onclick="copyText(shareLink)">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>Copy invite
                            </button>
                            <button type="button" class="btn ghost share-btn" onclick="shareUrl(shareLink)">
                                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>Share
                            </button>
                        </div>
                        <button type="button" class="btn" onclick="goToChat()">Open chat
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m0 0-6-6m6 6-6 6"/></svg>
                        </button>
                    </div>
                    <p class="hint">Your side of the chat opens only from this screen, so open it before leaving.</p>
                </div>

                <details class="facts">
                    <summary>How secure chat works</summary>
                    <ol>
                        <li>Messages are encrypted in your browser with AES-256-GCM.</li>
                        <li>Only one message exists at a time. Replying destroys the previous one.</li>
                        <li>Each link is bound to the first browser that opens it.</li>
                        <li>The key lives only in the link, after the # sign. It is never sent to the server.</li>
                        <li>The whole chat is deleted when it expires, or when either side destroys it.</li>
                    </ol>
                </details>
            </section>

            <!-- CHAT SESSION MODE -->
            <section id="chat-session-mode" class="view hidden">
                <div class="statusbar" role="status">
                    <span class="dot waiting" id="status-dot"></span>
                    <span id="status-text">Connecting…</span>
                    <span class="spacer"></span>
                    <span id="expires-in"></span>
                </div>

                <div class="stage" id="message-area">
                    <div id="no-message" class="empty">
                        <strong>No messages yet</strong>
                        Send the first one below.
                    </div>
                    <div id="message-display" class="hidden">
                        <div class="meta" id="message-meta"></div>
                        <div class="message" id="message-content"></div>
                        <button type="button" class="btn quiet" onclick="copyText(document.getElementById('message-content').textContent)">Copy message</button>
                    </div>
                    <div id="waiting-display" class="empty hidden">
                        <div class="rings"></div>
                        <strong id="waiting-title">Sent. Waiting for a reply…</strong>
                        Checking every 10 seconds.
                    </div>
                </div>

                <div id="reply-area" class="composer-wrap">
                    <div class="field composer">
                        <textarea id="reply-input" rows="1" placeholder="Type your reply…" aria-label="Reply" autocomplete="off" spellcheck="false"></textarea>
                        <button type="button" id="send-btn" class="send" onclick="sendMessage()" aria-label="Send message">
                            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m0 0-6 6m6-6 6 6"/></svg>
                        </button>
                    </div>
                    <p class="hint hidden" id="reply-hint">Sending your reply destroys the message above.</p>
                </div>

                <div class="chat-actions">
                    <button type="button" class="btn ghost" onclick="loadChat()">Refresh</button>
                    <button type="button" class="btn danger-ghost" onclick="destroyChat()">Destroy chat</button>
                </div>
            </section>

            <!-- ERROR MODE -->
            <section id="error-mode" class="view hidden">
                <div class="gate">
                    <div class="glyph danger"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></div>
                    <h1 class="headline">Nothing to see here.</h1>
                    <p class="lead" id="error-message"></p>
                    <div class="cta">
                        <button type="button" class="btn" onclick="window.location.href='/'">Back to home</button>
                    </div>
                </div>
            </section>
        </main>

        <footer>
            <a href="https://github.com/M-Igashi/flashpaper" target="_blank" rel="noopener">Open source</a> · No accounts · No tracking · Runs on <a href="https://workers.cloudflare.com" target="_blank" rel="noopener">Cloudflare Workers</a>
        </footer>
    </div>

    <!-- Destroy confirmation -->
    <div id="modal-overlay" class="overlay" onclick="closeModal(event)">
        <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div class="sheet-title" id="modal-title">Destroy this chat?</div>
            <div class="sheet-text">The current message and the chat itself are deleted for both of you. This cannot be undone.</div>
            <div class="stack">
                <button type="button" class="btn danger" onclick="confirmDestroyChat()">Destroy chat</button>
                <button type="button" class="btn ghost" onclick="closeModal()">Cancel</button>
            </div>
        </div>
    </div>

    <!-- Alert -->
    <div id="alert-overlay" class="overlay" onclick="closeAlert(event)">
        <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="alert-title">
            <div class="sheet-title" id="alert-title">Notice</div>
            <div class="sheet-text" id="alert-message"></div>
            <button type="button" class="btn" onclick="closeAlert()">OK</button>
        </div>
    </div>

    <div id="toast" class="toast" role="status" aria-live="polite"></div>

    <script>
        const cryptoApi = window.crypto || window.msCrypto;
        const $ = id => document.getElementById(id);

        function randomHex(byteLength) {
            const array = new Uint8Array(byteLength);
            cryptoApi.getRandomValues(array);
            return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
        }

        // Session ID management
        function sessionKey(chatId) {
            return 'flashpaper_session_' + chatId;
        }

        function getOrCreateSessionId(chatId) {
            let sessionId = localStorage.getItem(sessionKey(chatId));
            if (!sessionId) {
                sessionId = randomHex(32);
                localStorage.setItem(sessionKey(chatId), sessionId);
            }
            return sessionId;
        }

        function clearSessionId(chatId) {
            localStorage.removeItem(sessionKey(chatId));
        }

        // UI helpers
        let toastTimer = null;

        function toast(message) {
            const el = $('toast');
            el.textContent = message;
            el.classList.add('show');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
        }

        function setBusy(btn, busy) {
            btn.disabled = busy;
            btn.classList.toggle('busy', busy);
        }

        function copyText(text) {
            navigator.clipboard.writeText(text)
                .then(() => toast('Copied to clipboard'))
                .catch(() => toast('Copy failed. Press and hold the text to copy it.'));
        }

        function shareUrl(url) {
            navigator.share({ title: 'Flashpaper', url }).catch(() => {});
        }

        function autoGrow(el) {
            el.style.height = 'auto';
            el.style.height = el.scrollHeight + 'px';
        }

        function selectedTtl(name) {
            return parseInt(document.querySelector('input[name="' + name + '"]:checked').value);
        }

        // Chunked: spreading a large array into fromCharCode overflows the call stack
        function bytesToBase64(bytes) {
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }
            return btoa(binary);
        }

        async function generateKey() {
            return await cryptoApi.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        }

        async function exportKey(key) {
            const exported = await cryptoApi.subtle.exportKey('raw', key);
            return bytesToBase64(new Uint8Array(exported));
        }

        async function importKey(keyStr) {
            const keyData = Uint8Array.from(atob(keyStr), c => c.charCodeAt(0));
            return await cryptoApi.subtle.importKey('raw', keyData, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        }

        async function encrypt(plaintext, key) {
            const data = new TextEncoder().encode(plaintext);
            const iv = cryptoApi.getRandomValues(new Uint8Array(12));
            const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
            const combined = new Uint8Array(iv.length + ciphertext.byteLength);
            combined.set(iv);
            combined.set(new Uint8Array(ciphertext), iv.length);
            return bytesToBase64(combined);
        }

        async function decrypt(ciphertextB64, key) {
            const combined = Uint8Array.from(atob(ciphertextB64), c => c.charCodeAt(0));
            const iv = combined.slice(0, 12);
            const ciphertext = combined.slice(12);
            const decrypted = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
            return new TextDecoder().decode(decrypted);
        }

        // State
        let noteLink = '';
        let chatId = '';
        let encryptionKey = null;
        let encryptionKeyStr = '';
        let userToken = '';
        let sessionId = '';
        let creatorLink = '';
        let shareLink = '';
        let autoRefreshInterval = null;

        function setMode(mode) {
            document.body.dataset.mode = mode;
        }

        // Tab switching
        function switchTab(tab) {
            const isNote = tab === 'note';
            setMode(tab);
            $('tab-note').setAttribute('aria-selected', String(isNote));
            $('tab-chat').setAttribute('aria-selected', String(!isNote));
            $('note-create-mode').classList.toggle('hidden', !isNote);
            $('chat-create-mode').classList.toggle('hidden', isNote);
            history.replaceState(null, '', isNote ? '/' : '/chat');
        }

        // Note functions
        async function createNote() {
            const noteInput = $('note-input');
            const createBtn = $('note-create-btn');

            const plaintext = noteInput.value.trim();
            if (!plaintext) {
                toast('Write a note first');
                noteInput.focus();
                return;
            }

            setBusy(createBtn, true);

            try {
                const key = await generateKey();
                const keyStr = await exportKey(key);
                const ciphertext = await encrypt(plaintext, key);

                const response = await fetch('/api/note', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ciphertext, ttl_seconds: selectedTtl('note-ttl') })
                });

                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Failed to create note');

                noteLink = location.origin + '/view/' + data.id + '#' + keyStr;

                $('note-result-link').textContent = noteLink;
                noteInput.value = '';
                $('note-count').textContent = '0';
                $('note-form').classList.add('hidden');
                $('tabs').classList.add('hidden');
                $('note-result').classList.remove('hidden');
                window.scrollTo(0, 0);
            } catch (error) {
                console.error('Error:', error);
                showAlert('Failed to create note: ' + error.message, 'Something went wrong');
            } finally {
                setBusy(createBtn, false);
            }
        }

        function resetNote() {
            noteLink = '';
            $('note-result').classList.add('hidden');
            $('note-form').classList.remove('hidden');
            $('tabs').classList.remove('hidden');
            $('note-input').focus();
        }

        async function revealNote() {
            const revealBtn = $('note-reveal-btn');
            setBusy(revealBtn, true);

            try {
                const hash = location.hash.substring(1);
                const noteId = location.pathname.split('/view/')[1];

                const response = await fetch('/api/note/' + noteId);
                const data = await response.json();

                if (!data.success) throw new Error(data.error || 'Failed to retrieve note');

                const key = await importKey(hash);
                const plaintext = await decrypt(data.ciphertext, key);

                $('note-content').textContent = plaintext;
                $('note-gate').classList.add('hidden');
                $('note-display').classList.remove('hidden');
                window.scrollTo(0, 0);
            } catch (error) {
                console.error('Error:', error);
                showError(error.message || 'Failed to decrypt note.');
            }
        }

        // Chat functions
        async function createChat() {
            const initialMessage = $('chat-initial-message').value.trim();
            const createBtn = $('chat-create-btn');

            setBusy(createBtn, true);

            try {
                encryptionKey = await generateKey();
                encryptionKeyStr = await exportKey(encryptionKey);
                sessionId = randomHex(32);

                const payload = {
                    ttl_seconds: selectedTtl('chat-ttl'),
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

                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Failed to create chat');

                chatId = data.id;
                userToken = data.creatorToken;

                localStorage.setItem(sessionKey(chatId), sessionId);

                creatorLink = location.origin + '/chat/' + chatId + '#' + encryptionKeyStr + ':' + data.creatorToken;
                shareLink = location.origin + '/chat/' + chatId + '#' + encryptionKeyStr + ':' + data.recipientToken;

                $('chat-share-link').textContent = shareLink;
                $('chat-initial-message').value = '';
                $('chat-form').classList.add('hidden');
                $('tabs').classList.add('hidden');
                $('chat-result').classList.remove('hidden');
                window.scrollTo(0, 0);
            } catch (error) {
                console.error('Error:', error);
                showAlert('Failed to create chat: ' + error.message, 'Something went wrong');
            } finally {
                setBusy(createBtn, false);
            }
        }

        function goToChat() {
            window.location.href = creatorLink;
        }

        function setStatus(text, dotClass) {
            $('status-text').textContent = text;
            $('status-dot').className = 'dot' + (dotClass ? ' ' + dotClass : '');
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

                const incoming = data.hasMessage && !data.isMyMessage;
                const waiting = data.hasMessage && data.isMyMessage;

                $('no-message').classList.toggle('hidden', data.hasMessage);
                $('message-display').classList.toggle('hidden', !incoming);
                $('waiting-display').classList.toggle('hidden', !waiting);
                $('reply-area').classList.toggle('hidden', waiting);
                $('reply-hint').classList.toggle('hidden', !incoming);

                if (!data.hasMessage) {
                    setStatus('Ready');
                } else if (waiting) {
                    setStatus(data.messageRead ? 'Read' : 'Delivered', 'waiting');
                    $('waiting-title').textContent = data.messageRead
                        ? 'Read. Waiting for a reply…'
                        : 'Sent. Waiting for a reply…';
                } else {
                    setStatus('New message');
                    $('message-content').textContent = await decrypt(data.ciphertext, encryptionKey);
                    const time = new Date(data.messageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    $('message-meta').textContent = 'Received · ' + time;
                }
            } catch (error) {
                console.error('Error:', error);
                setStatus('Connection problem, retrying…', 'error');
            }
        }

        function updateExpiresIn(expiresAt) {
            const remaining = expiresAt - Date.now();
            const el = $('expires-in');

            if (remaining <= 0) {
                el.textContent = 'Expired';
                stopAutoRefresh();
                return;
            }

            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

            if (hours > 24) {
                el.textContent = 'Expires in ' + Math.floor(hours / 24) + 'd';
            } else if (hours > 0) {
                el.textContent = 'Expires in ' + hours + 'h ' + minutes + 'm';
            } else {
                el.textContent = 'Expires in ' + minutes + 'm';
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
            const replyInput = $('reply-input');
            const sendBtn = $('send-btn');
            const plaintext = replyInput.value.trim();

            if (!plaintext) {
                toast('Type a message first');
                replyInput.focus();
                return;
            }

            sendBtn.disabled = true;

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
                autoGrow(replyInput);
                await loadChat();
            } catch (error) {
                console.error('Error:', error);
                showAlert('Failed to send message: ' + error.message, 'Something went wrong');
            } finally {
                sendBtn.disabled = false;
            }
        }

        // Custom sheets instead of confirm()/alert(), which in-app browsers block
        function showModal() {
            $('modal-overlay').classList.add('show');
        }

        function closeModal(event) {
            if (event && event.target !== event.currentTarget) return;
            $('modal-overlay').classList.remove('show');
        }

        function showAlert(message, title = 'Notice', callback = null) {
            $('alert-title').textContent = title;
            $('alert-message').textContent = message;
            window.alertCallback = callback;
            $('alert-overlay').classList.add('show');
        }

        function closeAlert(event) {
            if (event && event.target !== event.currentTarget) return;
            $('alert-overlay').classList.remove('show');
            if (window.alertCallback) {
                window.alertCallback();
                window.alertCallback = null;
            }
        }

        function destroyChat() {
            showModal();
        }

        async function confirmDestroyChat() {
            closeModal();

            try {
                const response = await fetch('/api/chat/' + chatId + '?token=' + encodeURIComponent(userToken) + '&sessionId=' + encodeURIComponent(sessionId), {
                    method: 'DELETE'
                });

                const data = await response.json();

                if (!data.success) throw new Error(data.error || 'Failed to destroy chat');

                stopAutoRefresh();
                clearSessionId(chatId);

                showAlert('The chat and its last message are gone for good.', 'Chat destroyed', function() {
                    window.location.href = '/chat';
                });
            } catch (error) {
                console.error('Error:', error);
                showAlert('Failed to destroy chat: ' + error.message, 'Something went wrong');
            }
        }

        function showMode(id) {
            $('tabs').classList.add('hidden');
            ['note-create-mode', 'note-view-mode', 'chat-create-mode', 'chat-session-mode', 'error-mode']
                .forEach(m => $(m).classList.add('hidden'));
            $(id).classList.remove('hidden');
        }

        function showError(message) {
            stopAutoRefresh();
            showMode('error-mode');
            $('error-message').textContent = message;
        }

        function submitOnModEnter(inputId, action) {
            $(inputId).addEventListener('keydown', event => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    action();
                }
            });
        }

        // Initialize
        (function init() {
            const path = location.pathname;
            const hash = location.hash.substring(1);

            if (navigator.share) document.body.classList.add('can-share');

            $('note-input').addEventListener('input', event => {
                $('note-count').textContent = event.target.value.length.toLocaleString();
            });
            $('reply-input').addEventListener('input', event => autoGrow(event.target));
            submitOnModEnter('note-input', createNote);
            submitOnModEnter('chat-initial-message', createChat);
            submitOnModEnter('reply-input', sendMessage);

            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && autoRefreshInterval) loadChat();
            });

            if (path.startsWith('/view/')) {
                setMode('note');
                showMode('note-view-mode');
            } else if (path === '/chat' || path === '/chat/new') {
                switchTab('chat');
            } else if (path.startsWith('/chat/')) {
                setMode('chat');
                showMode('chat-session-mode');

                chatId = path.split('/chat/')[1];
                const parts = hash.split(':');
                if (!hash) {
                    showError('This chat link is incomplete. The key after the # sign is missing.');
                } else if (parts.length !== 2) {
                    showError('This chat link is not valid.');
                } else {
                    encryptionKeyStr = parts[0];
                    userToken = parts[1];
                    sessionId = getOrCreateSessionId(chatId);
                    loadChat();
                    startAutoRefresh();
                }
            } else {
                switchTab('note');
            }
        })();
    </script>
    <!-- Cloudflare Web Analytics --><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "{{CF_ANALYTICS_TOKEN}}"}'></script><!-- End Cloudflare Web Analytics -->
</body>
</html>`;
