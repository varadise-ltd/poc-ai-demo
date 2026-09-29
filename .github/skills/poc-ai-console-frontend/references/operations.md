# Operations

## Toolchain

`package.json` — no framework extras beyond Vue:

```json
"scripts": { "dev": "vite", "build": "vue-tsc --noEmit && vite build", "preview": "vite preview" },
"dependencies": { "vue": "^3.4.38" },
"devDependencies": { "@vitejs/plugin-vue": "^5.1.4", "typescript": "^5.5.4",
                     "vite": "^5.4.8", "vue-tsc": "^2.1.6" }
```

There is no linter, formatter, or test runner configured. Type checking happens as part of
`npm run build`.

`vite.config.ts` sets `server.host = '0.0.0.0'` and `server.port = 5173`. There is **no dev
proxy** — the browser calls the backend directly using `VITE_API_BASE`.

## Install and Run

```bash
cd poc-ai-demo
npm install          # first time only
npm run dev          # http://localhost:5173
```

The backend must be running on `http://localhost:8000` (the default `BASE_URL`), or set
`VITE_API_BASE` to point elsewhere. Backend CORS allows all origins, so the dev server works
without extra configuration.

Verify the stack is wired up:

```bash
curl -sS -o /dev/null -w 'backend=%{http_code}\n' http://localhost:8000/api/health
curl -sS -o /dev/null -w 'frontend=%{http_code}\n' http://localhost:5173/
```

## Type Checking and Build

```bash
npx vue-tsc --noEmit    # types only, fast
npm run build           # types + production build into dist/
```

`npm run build` fails on any TypeScript error, so always run it after changing types, the store,
or the API client. `dist/` is gitignored.

## Docker

`Dockerfile` is a two-stage build:

1. `node:20-alpine` — `npm ci`, then `npm run build`. The `VITE_API_BASE` build arg defaults to
   `""`, which makes the app use same-origin `/api/...` so nginx can proxy it.
2. `nginx:1.27-alpine` — copies `nginx.conf` to `/etc/nginx/conf.d/default.conf` and `dist/` to
   `/usr/share/nginx/html`, exposes port 80.

```bash
docker build -t poc-ai-demo .
docker run -d -p 8080:80 poc-ai-demo
```

Compose for the full stack lives in the **backend** project:

```bash
cd ../poc-ai-service && docker compose up -d --build   # frontend :8080, backend :8000
```

Point the image at a different backend at build time:

```bash
docker build --build-arg VITE_API_BASE=http://10.0.0.5:8000 -t poc-ai-demo .
```

### nginx Configuration Notes

`nginx.conf` handles:

- SPA fallback: `try_files $uri $uri/ /index.html`
- `client_max_body_size 20m` — needed for face image uploads (nginx defaults to 1 MB → 413)
- gzip for css/js/json/svg
- `/api/` → `proxy_pass $backend_upstream`, where
  `set $backend_upstream "http://${BACKEND_HOST}:8000"` (host from the `BACKEND_HOST` env;
  compose passes `backend`, K8s passes the Service FQDN)
- **MJPEG support** for `/api/stream`: `proxy_buffering off`, `proxy_cache off`,
  `proxy_read_timeout 3600s`, `chunked_transfer_encoding on`. Without these the live view
  freezes or drops after 60 s.

**`BACKEND_HOST` must be a bare hostname** — no scheme, no port, no path. The template appends
`:8000` itself, so `BACKEND_HOST=poc-ai-service:8000` renders
`http://poc-ai-service:8000:8000` and nginx rejects it **at request time**
(`invalid port in upstream`), making every `/api` call return 500. `nginx -t` does **not** catch
this: the value lives in a `set` string that is only evaluated per request.

`docker-entrypoint.d/05-normalize-backend-host.envsh` runs before the template is rendered and
handles both defects, logging a `WARNING` each time:

1. strips a stray scheme / port / path (the `host:8000:8000` → **500** case);
2. qualifies a **dotless** host with the first `search` domain from `/etc/resolv.conf`, mimicking
   glibc (the short-name → **502** `could not be resolved` case). FQDNs and IP literals are left
   alone, and Docker Compose (no `search` domain) keeps a bare `backend` as-is.

A misconfigured deploy therefore degrades to a warning instead of taking the whole API down —
but the deploy config is still the thing to fix. The filename must end in `.envsh` (the official
entrypoint **sources** those, so the export reaches `20-envsubst-on-templates.sh`) and the `05-`
prefix keeps it ahead of `15-local-resolvers.envsh` / `20-envsubst` (`sort -V` order).

> The directory must be **committed to git**: Jenkins/Kaniko builds from the git checkout, so an
> untracked `docker-entrypoint.d/` fails the build with
> `failed to get fileinfo for .../docker-entrypoint.d: no such file or directory`.

The container healthcheck uses `http://127.0.0.1/`, **not** `localhost`: nginx listens IPv4-only
while `localhost` can resolve to `::1` first, which makes the probe fail with "Connection
refused" even though the app serves fine.

## Build-Time vs Runtime Config

`VITE_API_BASE` is inlined by Vite at **build** time. A built `dist/` cannot be repointed at a
different backend without rebuilding (or passing a build arg). If runtime configurability is
needed, load the base URL from a runtime source (e.g. `window.__CONFIG__` or a generated
`config.js`) instead of `import.meta.env`.

## Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| Blank page, no network calls | Backend down or wrong `BASE_URL`. Check `http://localhost:8000/api/health`. |
| CORS error in the console | Backend not running, or a proxy is stripping CORS headers. |
| `404` on `GET /api/camera-ai` | Backend older than the camera-AI feature. That endpoint must exist for the Camera tab. |
| "Add AI model" does nothing | The `<select>` must have both a name and a **Base AI model** (`base_script_id`); the backend rejects a missing/invalid base with `422`. Check `POST /api/scripts` in the network tab. |
| Live video freezes after ~60 s behind Docker | MJPEG proxy settings missing in `nginx.conf`. |
| Every `/api` call returns **500**, nginx log shows `invalid port in upstream "<namespace>-ai-service:8000:8000"` | Deployment set `BACKEND_HOST` **with** a port. The template appends `:8000` itself. Fix: set it to the bare Service FQDN (`poc-ai-service.<namespace>.svc.cluster.local`). Since the entrypoint normalizer landed, a stray port is stripped with a startup `WARNING`, but fix the deploy env too. Note `nginx -t` passes — the error only appears per request. |
| Every `/api` call returns 502 and the log says `could not be resolved` / `host not found in upstream` | `BACKEND_HOST` is a short name (nginx `resolver` does not expand the `/etc/resolv.conf` search domain) or a wrong namespace. Use the full FQDN. |
| `recv() failed (111: Connection refused) while resolving, resolver: 127.0.0.11:53` inside Kubernetes | Hardcoded Docker-only resolver. Leave `NGINX_ENTRYPOINT_LOCAL_RESOLVERS` untouched so the entrypoint derives the cluster DNS from `/etc/resolv.conf`. |
| Upload returns `413` | `client_max_body_size` too small in `nginx.conf`. |
| Frontend container `unhealthy` but the page loads | Healthcheck must target `127.0.0.1`, not `localhost`. |
| Reports show 0 while the backend has data | The dashboard reads durable `events` / `passage_facts` and excludes synthetic MOCK rows. Check the time range and that a detection worker actually ran. |
| Face save shows a red "already registered" message | Working as intended: the backend rejects duplicate people with `409` (same name, same photo, or the same face). Edit or delete the existing record, or upload a different person's photo. This is **not** the old "warnings keep the modal open" behavior. |
| `vue-tsc` error after adding a tab | `TabId` union, `TabNav.tabs`, and `App.vue` must all include the new id. |
| Stale UI after a rebuild | Browser cache. Hard-reload; asset filenames are content-hashed by Vite. |

## Git Notes

The repo's default branch is `main`; active development happens on `dev`. `dist/` and
`node_modules/` are gitignored. If you add generated assets, extend `.gitignore` rather than
committing them.

## What Is Deliberately Absent

No router, no Pinia, no UI kit, no chart library, no tests, no linter, no `.env`. Keeping the
dependency surface at Vue + Vite is a project decision — adding to it should be justified by a
concrete need (a real chart, a real form library), not convenience.
