# Flashpaper

Self-destructing encrypted notes and chats.

## Try It Now

**[flashpaper.ravers.workers.dev](https://flashpaper.ravers.workers.dev/)**

No signup. No cookies. No tracking. Just write and share.

## What It Does

**Notes** - Write a secret note, get a link. The note is destroyed after it's read once.

**Chat** - Start a private conversation. Only one message exists at a time - each reply destroys the previous one.

Everything is encrypted in your browser before it leaves. The server never sees your content.

## Self-Hosting

Runs on Cloudflare Workers (free tier works).

```bash
git clone https://github.com/M-Igashi/flashpaper.git
cd flashpaper
npm install
npx wrangler login
npx wrangler deploy
```

## How It Works

- AES-256-GCM encryption happens in your browser
- Encryption keys stay in the URL fragment (`#...`) which is never sent to servers
- Content auto-expires (1 hour / 24 hours / 7 days)
- Chat sessions are locked to the first browser that opens each link

## Technical Details

<details>
<summary>Privacy Model</summary>

**What the server stores (temporarily):**
- Encrypted ciphertext (unreadable without URL fragment key)
- Hashed tokens (SHA-256)
- Expiry timestamps

**What the server never sees:**
- Plaintext content
- Encryption keys
- Original access tokens

</details>

<details>
<summary>API Reference</summary>

### Notes

```
POST /api/note
  Body: { ciphertext: string, ttl_seconds?: number }
  Returns: { id: string }

GET /api/note/:id
  Returns: { ciphertext?: string, error?: string }
```

### Chat

```
POST /api/chat
  Body: { sessionId: string, ttl_seconds?: number, ciphertext?: string }
  Returns: { id, creatorToken, recipientToken, expiresAt }

GET /api/chat/:id?token=...&sessionId=...
  Returns: { role, hasMessage, ciphertext?, expiresAt }

POST /api/chat/:id/message
  Body: { token, sessionId, ciphertext }

DELETE /api/chat/:id?token=...&sessionId=...
```

</details>

<details>
<summary>Tech Stack</summary>

- Cloudflare Workers + Durable Objects
- Web Crypto API (AES-256-GCM)
- SQLite (in Durable Objects)

</details>

## License

MIT
