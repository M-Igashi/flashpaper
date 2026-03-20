# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

Only the latest deployed version is supported.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it via [GitHub Security Advisories](https://github.com/masanarihigashi/flashpaper/security/advisories/new).

- **Do NOT open a public issue** for security vulnerabilities.
- You can expect an initial response within 7 days.
- If the vulnerability is confirmed, a fix will be prioritized and deployed as soon as possible.

## Security Design

- All encryption is performed **client-side** in the browser using the Web Crypto API.
- The server never has access to plaintext content or encryption keys.
- Notes are automatically destroyed after being read once.
