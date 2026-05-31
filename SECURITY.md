# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report privately via GitHub's [Security Advisories](https://github.com/BillLucky/echocut/security/advisories/new),
or email **bill.libiao@gmail.com**. Include steps to reproduce and the affected version.
We aim to acknowledge reports within a few days.

## Scope notes

echocut is **local-first** — it processes media on your own machine and does not upload
anything by default. Be mindful that:

- `.env` may hold API keys (e.g. `MINIMAX_API_KEY`) and Telegram tokens — it is gitignored;
  never commit it.
- `publish` uploads to S3/MinIO using your own credentials (`ZDE_S3_*`); the returned URLs
  are presigned and time-limited.
- LLM features call your configured Ollama endpoint; keep it on a trusted network.

## Supported versions

The latest released version receives security fixes.
