# 🔥 Flashpaper

> "This message will self-destruct..."

A privacy-first, self-destructing notes service built entirely on Cloudflare Workers + Durable Objects. No databases, no persistent logs—just ephemeral, encrypted messages that vanish after being read.

## Features

- 🔐 **End-to-end encryption** - Decryption key never leaves your browser (URL fragment)
- 💨 **True ephemerality** - Notes stored only in Durable Objects memory, not persistent storage
- 🕵️ **Minimal traces** - Only access logs exist; content is never logged
- 🔥 **One-time read** - Notes are deleted immediately after viewing
- ⏰ **Auto-expiry** - Unread notes expire and vanish

## How It Works

1. **Create**: Your message is encrypted client-side, sent to a Durable Object (memory only)
2. **Share**: You get a URL with the decryption key in the fragment (`#key`)
3. **Read**: Recipient opens URL, DO returns & deletes the encrypted note, browser decrypts
4. **Gone**: The note no longer exists anywhere

## Privacy Model

| What | Logged? |
|------|---------|
| Access to `/create` | Yes (Cloudflare access logs) |
| Access to `/view/{id}` | Yes (Cloudflare access logs) |
| Note content | **No** (memory only, encrypted) |
| Decryption key | **No** (URL fragment, never sent to server) |

## Tech Stack

- Cloudflare Workers
- Durable Objects (memory-only, no `storage.put()`)
- Web Crypto API (AES-GCM)

## License

MIT
