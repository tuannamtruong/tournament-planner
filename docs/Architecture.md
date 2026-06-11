## Architecture

```
[Director's laptop]
  Node + Fastify on localhost:37325
   ├─ admin browser UI (admin/public/)
   ├─ admin/data/tournament.json   ← single source of truth
   ├─ pairing engine (round_robin / swiss / manual)
   ├─ standings engine (tiebreaker authority)
   └─ AWS SDK ──► S3 PUT when operator clicks "Force publish"
                              │
                              ▼
                  ┌──────────────────────────────────────────────┐
                  │ S3 bucket: tp-result-<sfx>                   │
                  │ (website hosting enabled, public read on     │
                  │  index/knockout/assets/data only)            │
                  │  index.html, knockout.html  Cache-Control 1h │
                  │  assets/app.css, *.js       Cache-Control 1h │
                  │  data/groups.json           Cache-Control 15s│
                  │  data/knockout.json         Cache-Control 15s│
                  │  data/version.json          Cache-Control 5s │
                  │  private/backups/*.json     (denied to web)  │
                  └──────────────────────────────────────────────┘
                              ▲
                              │ plain HTTP, browser-cached per Cache-Control
                  [Public spectators' browsers]
```

### Why this shape

| Decision | Why | Alternative considered |
|---|---|---|
| Admin runs locally | No server to host, no admin auth needed, pairing logic just runs in Node, the DB is a file on the laptop | Hosted admin on Lightsail (~$3.50/mo, +Caddy +cookies +systemd +backups) — strictly more parts |
| JSON file as source of truth | Single writer, <10 MB of data, trivial to inspect/edit in an emergency, same shape that gets pushed to S3 | SQLite: nicer queries, but adds a transform step before publishing and a native dep |
| S3 website hosting, no CDN, no custom domain | Cheapest possible; zero servers; no DNS/cert setup; result-site URL is just the bucket endpoint | CloudFront + ACM + custom domain: prettier URL and HTTPS, but adds 3 services to provision and is unnecessary for one event |
| Poll `version.json` for updates | Cacheable, cheap, no SSE infrastructure, survives reconnects | SSE: needs a long-lived server we don't have anymore |
| IAM user with `s3:PutObject` only | Least-privilege, keys live in `~/.aws/credentials` on the laptop | IAM role: only for EC2/Lambda; not applicable to a laptop |
| Plain HTML + vanilla JS (no build) | ~8 screens total; React/Vite tax doesn't pay back | React+Vite: more dev tax than payoff at this scale |