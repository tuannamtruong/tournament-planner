## HTTP API

All responses are JSON. State-changing requests bump `pendingChanges` via a Fastify `onResponse` hook (except `/api/publish/*` itself); the actual S3 push is operator-triggered through `POST /api/publish/force`.

### State
- `GET    /api/state` — full tournament JSON
- `PUT    /api/state/name` `{ name }`

### Participants
- `POST   /api/participants` `{ name, club?, category?, class?, seed? }`
- `PATCH  /api/participants/:id` `{ name?, club?, category?, class?, seed?, withdrawn? }`
- `DELETE /api/participants/:id` — also removes from all `group.members`
- `POST   /api/participants/import-csv` `{ csv }` — columns: `name, club, category, class, seed` (header row required; lowercase or capitalized accepted)

### Groups
- `POST   /api/groups` `{ name, mode, category?, classes?, members? }` — `classes` is an array of class codes; empty array means "any class"
- `PATCH  /api/groups/:id` — partial of `{ name, mode, category, classes, members }`
- `DELETE /api/groups/:id`
- `POST   /api/groups/:id/next-round` — generate via the group's `mode`; throws on `manual` and on schedule-complete

### Matches
- `PATCH  /api/groups/:gid/matches/:mid` `{ score?, status?, court? }` — auto-stamps `startedAt` on first `live`, `finishedAt` on first `done`
- `POST   /api/groups/:gid/matches` `{ p1, p2, court?, roundNo? }` — manual groups; round is created if absent

### Knockout (multi-bracket)
- `POST   /api/knockouts` `{ name, category?, classes?, size, seeds? }` — creates one bracket. `size` is the requested player count (any integer ≥ 2); the server rounds up to the next power of 2 and seats unfilled positions as BYE. BYE pairings auto-advance the lone player to the next round.
- `PATCH  /api/knockouts/:kid/round/:r/slot/:s` `{ p1?, p2?, score?, winner? }` — setting `winner` propagates to the next round's correct slot (odd slot → p1, even → p2)
- `DELETE /api/knockouts/:kid`

### Publish
- `GET    /api/publish/status` — `{ configured, lastSuccess, lastError, pendingChanges, inFlight }`
- `POST   /api/publish/force` — pushes synchronously (`forcePush()` → `runPublish()`); 502 with error message on failure. No automatic retry — caller re-tries by clicking again.
- `POST   /api/publish/backup` — manual push of `tournament.json` snapshot to `private/backups/`

### Local viewer (dev preview of the result site)
- `GET    /view/`, `/view/index.html`, `/view/knockout.html`, `/view/assets/*` — static mount of `result-site/`
- `GET    /view/data/version.json` — same shape as the S3 file, derived live from `tournament.json`; `Cache-Control: max-age=5`
- `GET    /view/data/groups.json` — derived live; `Cache-Control: max-age=15`
- `GET    /view/data/knockout.json` — derived live; shape `{ tournament, brackets: [{ id, name, category, classes, size, rounds }, ...] }`; `Cache-Control: max-age=15`
