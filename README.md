# 🔥 Flashpaper

> "This message will self-destruct..."

A privacy-first, self-destructing encrypted notes service built on Cloudflare Workers + Durable Objects with SQLite storage.

## 🚀 Live Demo

**https://flashpaper.ravers.workers.dev**

Feel free to use it! It's free and open for everyone.

## Features

- 🔐 **End-to-end encryption** - AES-256-GCM encryption in your browser; decryption key never leaves your device (stored in URL fragment)
- 🔥 **One-time read** - Notes are permanently deleted immediately after viewing
- ⏰ **Auto-expiry** - Notes auto-expire after 1 hour, 24 hours, or 7 days (configurable)
- 🧹 **Automatic cleanup** - Cron job runs hourly to purge expired notes
- 🌐 **Zero-knowledge** - Server only stores encrypted blobs; it cannot read your messages

## How It Works

1. **Create**: Enter your secret message → encrypted in your browser with AES-256-GCM
2. **Store**: Only the encrypted blob is sent to the server (key stays in your browser)
3. **Share**: You get a URL like `https://flashpaper.ravers.workers.dev/view/abc123#SECRET_KEY`
4. **Read**: Recipient opens the link → server returns & deletes the encrypted note → browser decrypts with the key from URL fragment
5. **Gone**: The note is permanently destroyed

## Privacy Model

| Data | Stored on Server? | Encrypted? |
|------|-------------------|------------|
| Note content | Encrypted blob only | ✅ AES-256-GCM |
| Decryption key | ❌ Never | N/A (URL fragment) |
| Access logs | Cloudflare standard | N/A |

The URL fragment (`#key`) is never sent to the server per HTTP specification, so only the recipient with the full URL can decrypt the message.

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Storage**: Durable Objects with SQLite
- **Encryption**: Web Crypto API (AES-256-GCM)
- **Cleanup**: Cron Triggers (hourly)

## Self-Hosting

### Prerequisites

- Cloudflare account (free tier works!)
- Node.js & npm
- Wrangler CLI

### Deploy

```bash
# Clone the repository
git clone https://github.com/ravers-dev/flashpaper.git
cd flashpaper

# Install dependencies
npm install

# Login to Cloudflare
npx wrangler login

# Deploy
npx wrangler deploy
```

### Configuration

Edit `wrangler.toml` to customize:

```toml
name = "flashpaper"
main = "src/worker.js"
compatibility_date = "2024-12-01"

[durable_objects]
bindings = [
  { name = "NOTE_STORE", class_name = "NoteStore" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["NoteStore"]

# Cron trigger - runs every hour to clean up expired notes
[triggers]
crons = ["0 * * * *"]
```

## API

### Create a note

```bash
POST /api/note
Content-Type: application/json

{
  "ciphertext": "base64-encoded-encrypted-data",
  "ttl_seconds": 86400  # optional, defaults to 7 days max
}

# Response
{
  "id": "abc123xyz"
}
```

### Retrieve a note (one-time)

```bash
GET /api/note/{id}

# Response (success)
{
  "success": true,
  "ciphertext": "base64-encoded-encrypted-data"
}

# Response (not found or already read)
{
  "success": false,
  "error": "Note not found or already read"
}
```

## License

MIT