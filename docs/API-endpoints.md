## HTTP API

All responses are JSON. State-changing requests trigger `schedulePublish()` via a Fastify `onResponse` hook (except `/api/publish/*` itself).

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
- `POST   /api/groups/:id/next-round` — generate via the group's `mode`; throws on `manual`/`table` and on schedule-complete

### Matches
- `PATCH  /api/groups/:gid/matches/:mid` `{ score?, status?, court? }` — auto-stamps `startedAt` on first `live`, `finishedAt` on first `done`
- `POST   /api/groups/:gid/matches` `{ p1, p2, court?, roundNo? }` — manual/table groups; round is created if absent

### Knockout
- `POST   /api/knockout` `{ size, seeds? }` — creates an empty bracket of the given size and fills round 1 by standard single-elim seeding from the `seeds` array
- `PATCH  /api/knockout/round/:r/slot/:s` `{ p1?, p2?, score?, winner? }` — setting `winner` propagates to the next round's correct slot (odd slot → p1, even → p2)
- `DELETE /api/knockout`

### Publish
- `GET    /api/publish/status` — `{ configured, lastSuccess, lastError, pendingChanges, inFlight, nextRetryAt }`
- `POST   /api/publish/force` — cancels any pending debounce/retry and pushes synchronously; 502 with error message on failure
- `POST   /api/publish/backup` — manual push of `tournament.json` snapshot to `private/backups/`

### Local viewer (dev preview of the result site)
- `GET    /view/`, `/view/index.html`, `/view/knockout.html`, `/view/assets/*` — static mount of `result-site/`
- `GET    /view/data/version.json` — same shape as the S3 file, derived live from `tournament.json`; `Cache-Control: max-age=5`
- `GET    /view/data/groups.json` — derived live; `Cache-Control: max-age=15`
- `GET    /view/data/knockout.json` — derived live (returns `null` if no bracket); `Cache-Control: max-age=15`
