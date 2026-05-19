# Contributing

> If you can build the panel and read TypeScript, you can contribute. This
> document is the minimum survival kit.

## Layout

```
.
├── Dockerfile                  # Hytale game-server image
├── docker-compose.yml          # Stack: hytale + hytale-manager
├── scripts/                    # In-container helpers (entrypoint, backup, hook)
├── plugins/kyuubisoft-api/     # KyuubiSoft Java plugin loaded into Hytale
├── manager/
│   ├── Dockerfile              # Manager (Node + Vue static) image
│   ├── entrypoint.sh
│   ├── backup-hook.sh          # mirrored copy of scripts/backup-hook.sh
│   ├── backend/                # Express/TS API + WebSocket
│   └── frontend/               # Vue 3 + Vite + Tailwind UI
└── docs/                       # Concept docs (V3_ROADMAP, V3_API_CHEATSHEET, ...)
```

## Local dev loop

```bash
# Backend
cd manager/backend
npm install
npm run dev                     # tsx watch on http://localhost:18080

# Frontend (in another terminal)
cd manager/frontend
npm install
npm run dev                     # Vite on http://localhost:3000 with /api proxy
```

The frontend dev server proxies `/api/*` to `http://localhost:18080`, so the
backend has to be running for anything except static views.

For a full stack with a real Hytale container:

```bash
cp .env.example .env            # set MANAGER_USERNAME / PASSWORD / JWT_SECRET / CORS_ORIGINS
docker compose up -d --build
```

## Conventions

- **Commits**: imperative subject, ~70 chars, lower-case verb (`add ws ticket race fix`). No emoji.
- **Branches**: `claude/<topic>-<slug>`, `feat/<topic>`, `fix/<topic>`. Long-running branches rebase rather than merge.
- **Audit log**: every mutating endpoint MUST call `audit(req, action, opts)` from `services/audit.ts`. Pick a stable action name (`server.start`, `apikey.created`, …) — the audit-log UI groups by action.
- **Permissions**: add new permission keys to `types/permissions.ts`. Use the most specific scope; the `*` wildcard belongs to admins only.
- **Errors**: `{ error, detail?, code?, issues? }`. Don't leak stack traces in production responses.
- **Pagination**: cursor-based (`?limit=&cursor=`), never offset.
- **i18n**: don't hardcode user-facing strings in `.vue` files. Add a key to `src/i18n/<locale>.json`. PRs that add untranslated strings will get fixed in review, not bounced.
- **No `any`** unless you have a comment explaining the boundary it sits at.

## CI

`.github/workflows/ci.yml` runs on every PR:

- Backend: `tsc --noEmit`, `vitest run --passWithNoTests`
- Frontend: `vite build`
- `diff scripts/backup-hook.sh manager/backup-hook.sh` — these two files must stay identical
- Docker images for both Dockerfiles build

CI must be green for a merge. Don't push fixes labeled "fix CI" — push the
actual fix.

## V3 roadmap

If you're picking up a feature, check [docs/V3_ROADMAP.md](docs/V3_ROADMAP.md)
for context, scope and the open questions that influence design choices.

The roadmap is opinionated but not law — if you have a better idea, open a
discussion before writing code.

## License & DCO

GPL-3.0 (see [LICENSE](LICENSE)). By submitting a PR you confirm your work is
yours to license under GPL-3.0.
