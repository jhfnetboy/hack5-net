# HackVideo VPS Fallback

Use this if Cloudflare upload or playback is not acceptable from mainland China.

## Run With Docker Compose

```bash
cp .env.example .env
# edit AUTH_SECRET, RESEND_API_KEY, MAIL_FROM
docker compose up -d --build
```

The app listens on port `8787`. Put nginx, Caddy, or a load balancer in front of it for HTTPS.

## Storage

- Videos and thumbnails are stored in `vps/data/uploads`.
- Metadata, sessions, and OTP hashes are stored in `vps/data/db.json`.

For a small hackathon this is acceptable. If you expect heavy concurrent traffic, replace the JSON store with SQLite or Postgres.

## Email

Set `RESEND_API_KEY` for real email. In development, set `DEV_MODE=true` and the OTP is returned by the API response and logged to stdout.

## Nginx Notes

If nginx is in front, allow 200 MB uploads:

```nginx
client_max_body_size 210m;
proxy_request_buffering off;
```

Serve over HTTPS so the session cookie is protected in transit.
