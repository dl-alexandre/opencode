# Opencode Proxy (Bun + TypeScript)

Lightweight reverse proxy that:
- Listens on port 4096 and forwards to the opencode server on 4097.
- Handles Google OAuth (Antigravity-compatible) and stores tokens server-side per user.
- Serves a simple status page at `/` and health at `/health`.

## How it works
- `proxy.ts` (Bun runtime) starts an HTTP server and an `http-proxy` instance.
- Auth flow:
  1. Hit `/auth/google/start?user=<id>&project=<id>` → redirects to Google OAuth.
  2. Google redirects to `GOOGLE_REDIRECT_URI` (default `http://localhost:4096/auth/google/callback` or whatever you set).
  3. Callback stores the token under a user key and returns JSON.
- Tokens are stored per user in `~/.opencode/google-auth.json` (override with `TOKEN_PATH`). Keys come from `user` in the state, or fallback to email, or `default`.
- Downstream requests to 4096 are proxied to 4097 unchanged.

## Endpoints
- `/` — status page.
- `/health` (alias `/global/health`) — returns `{status:"ok", target:"http://127.0.0.1:4097"}`.
- `/auth/google/start?user=<id>&project=<id>` — begin OAuth (user/project optional).
- `/auth/google/callback` (or whatever path is in `GOOGLE_REDIRECT_URI`) — OAuth callback, stores token.
- `/auth/google/token?user=<id>` — fetch stored token for a user; 404 if missing.

## Environment variables (`packages/proxy/.env`)
- `GOOGLE_REDIRECT_URI` — required; must match Google OAuth client redirect (e.g. `https://mini.milcgroup.com/callback` or `http://localhost:4096/auth/google/callback`).
- `GOOGLE_REDIRECT_CLIENT_ID` — Google OAuth client ID.
- `GOOGLE_REDIRECT_CLIENT_SECRET` — Google OAuth client secret.
- `PORT` (default `4096`) — proxy port.
- `TARGET_HOST` (default `127.0.0.1`) — upstream opencode host.
- `TARGET_PORT` (default `4097`) — upstream opencode port.
- `TOKEN_PATH` (optional) — override token storage file (default `~/.opencode/google-auth.json`).

## Restarting (LaunchAgent)
```
launchctl bootout gui/$(id -u)/com.milc.opencode-proxy
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.milc.opencode-proxy.plist
launchctl kickstart -k gui/$(id -u)/com.milc.opencode-proxy   # optional if bootstrap didn’t auto-start
```

## Notes
- If using CloudFront (mini.milcgroup.com), ensure `GOOGLE_REDIRECT_URI` matches the public URL and is whitelisted in the Google OAuth client.
- `CALLBACK_PATH` is derived from the redirect URI’s pathname and also accepts `/auth/google/callback` as a fallback.
- Project discovery calls to Antigravity endpoints may log 403s; they don’t block auth storage.
