# Flashpaper 🔥📝

Self-destructing encrypted notes and chats. A privacy-focused alternative to Privnote.

**Live Demo:** [flashpaper.ravers.workers.dev](https://flashpaper.ravers.workers.dev/)

## Features

### 📝 Notes
- **One-time read** - Notes are permanently destroyed after viewing
- **Client-side encryption** - AES-256-GCM encryption in your browser
- **Zero-knowledge** - Server never sees plaintext content
- **Auto-expiry** - Notes auto-delete after 1 hour, 24 hours, or 7 days

### 💬 Secure Chat
- **Ephemeral messaging** - Only ONE message exists at a time (previous destroyed on reply)
- **Browser-bound sessions** - Chat locked to first browser that opens each link
- **Dual authentication** - Separate URLs for creator and recipient
- **Manual destruction** - Either party can destroy chat at any time
- **Auto-refresh** - Checks for new messages every 10 seconds

## Privacy Model

### Notes
| What | Where | Security |
|------|-------|----------|
| Encrypted content | Server (Durable Objects) | AES-256-GCM encrypted |
| Encryption key | URL fragment only | Never sent to server |
| Note ID | URL path | Random, unguessable |

### Chat
| What | Where | Security |
|------|-------|----------|
| Encrypted messages | Server (Durable Objects) | AES-256-GCM encrypted |
| Encryption key | URL fragment only | Never sent to server |
| Access tokens | URL fragment | SHA-256 hashed before storage |
| Session IDs | localStorage + Server | SHA-256 hashed, bound on first access |

### Session Binding (Chat)
Each chat URL can only be used from the **first browser that opens it**:

1. When you create a chat, your browser generates a unique session ID stored in localStorage
2. This session ID is hashed and bound to your role (creator) on the server
3. When you share the link, the recipient's browser generates its own session ID
4. The recipient's session is bound on their first access
5. Any subsequent access attempt from a different browser is **rejected**

This prevents:
- Link interception attacks (MITM cannot use stolen links)
- Unauthorized access even with the correct URL
- Session hijacking

### What We Store in Application Database (Temporarily)
- Encrypted ciphertext (unreadable without URL fragment key)
- Token hashes (SHA-256, cannot reverse to original tokens)
- Session ID hashes (SHA-256, bound on first access)
- Creation/expiry timestamps
- Message read status (for chat)

### What We Never Store in Application Database
- Plaintext content
- Encryption keys
- Original tokens or session IDs

### Infrastructure-Level Data
Like any web service, standard infrastructure logs may temporarily exist:

- **IP addresses** - May be logged by Cloudflare for DDoS protection and abuse prevention (standard for all websites)
- **Request metadata** - Timestamps, HTTP headers, etc.

This is standard for all web services and does not compromise message security because:
1. Message content is encrypted before leaving your browser
2. Encryption keys exist only in URL fragments (never sent to servers)
3. Even with full server access, messages cannot be decrypted

If you require IP-level anonymity, consider using Tor or a VPN.

## Technical Stack

- **Runtime:** Cloudflare Workers (edge computing)
- **Storage:** Durable Objects with SQLite
- **Encryption:** Web Crypto API (AES-256-GCM)
- **Authentication:** URL-embedded tokens + browser session binding
- **Cleanup:** Hourly cron job for expired content

## Self-Hosting

### Prerequisites
- Cloudflare account with Workers Paid plan (for Durable Objects)
- Node.js and npm
- Wrangler CLI

### Deploy

```bash
# Clone the repository
git clone https://github.com/M-Igashi/flashpaper.git
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
name = "flashpaper"           # Worker name
main = "src/worker.js"        # Entry point

[vars]
CF_ANALYTICS_TOKEN = ""       # Optional: Cloudflare Analytics

[[durable_objects.bindings]]
name = "NOTE_STORE"
class_name = "NoteStore"

[[durable_objects.bindings]]
name = "CHAT_STORE"
class_name = "ChatStore"

[[durable_objects.bindings]]
name = "STATS_STORE"
class_name = "StatsStore"

[triggers]
crons = ["0 * * * *"]         # Cleanup every hour
```

## API Reference

### Notes

```
POST /api/note
  Body: { ciphertext: string, ttl_seconds?: number }
  Returns: { id: string }

GET /api/note/:id
  Returns: { success: boolean, ciphertext?: string, error?: string }
```

### Chat

```
POST /api/chat
  Body: { sessionId: string, ttl_seconds?: number, ciphertext?: string }
  Returns: { success: boolean, id: string, creatorToken: string, recipientToken: string, expiresAt: number }

GET /api/chat/:id?token=...&sessionId=...
  Returns: { success: boolean, role: string, hasMessage: boolean, isMyMessage: boolean, messageRead: boolean, ciphertext?: string, expiresAt: number, messageAt?: number }

POST /api/chat/:id/message
  Body: { token: string, sessionId: string, ciphertext: string }
  Returns: { success: boolean, messageAt: number }

DELETE /api/chat/:id?token=...&sessionId=...
  Returns: { success: boolean, message: string }
```

### Stats

```
GET /api/stats
  Returns: { notes: {...}, chats: {...}, daily: [...], generated_at: string }
```

## URL Structure

### Notes
```
/view/{noteId}#{encryptionKey}
```

### Chat
```
/chat/{chatId}#{encryptionKey}:{accessToken}
```

- `encryptionKey` - Base64-encoded AES-256 key (never sent to server)
- `accessToken` - 48-character hex token (hashed on server)

## Security Considerations

1. **URL Fragment Security** - The `#` portion of URLs is never sent to servers
2. **Session Binding** - Chats are locked to the first browser that opens each link
3. **Token Hashing** - All tokens are SHA-256 hashed before storage
4. **Auto-Cleanup** - Expired content is automatically deleted hourly
5. **End-to-End Encryption** - Content encrypted client-side, decryption keys never leave your browser
6. **HTTPS Only** - All traffic is encrypted in transit

## Limitations

- **localStorage Required** - Chat requires localStorage for session binding
- **No Message History** - Only one message exists at a time in chat
- **Browser-Bound** - Cannot access same chat from multiple devices
- **No Offline Support** - Requires internet connection

## License

MIT License - feel free to self-host and modify.

## Contributing

Issues and pull requests are welcome at [GitHub](https://github.com/M-Igashi/flashpaper).
