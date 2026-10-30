# Running HiveMind in Docker

Everything here was built and run on this project (Docker 29, Node 24 image, 347 MB). What was checked is listed at the end.

## Quick start

```bash
cp .env.example .env          # add GROQ_API_KEY and/or OPENAI_API_KEY (Claude is off by default)
docker compose up -d --build
open http://localhost:8788    # the first account you create is the administrator
```

`docker compose logs -f app` shows the server. `docker compose down` stops it; the data stays in the `hivemind-data` volume.

## What is in the box

| File | Purpose |
|---|---|
| `Dockerfile` | One image for the dashboard server and for the one-off jobs (`run`, `ocr`, `backup`...). Node 24, no npm packages to install, runs as the unprivileged `node` user, `tini` as the init process, a built-in health check. |
| `docker-compose.yml` | The `app` service, plus a `backup` service that writes a consistent database copy every 24 hours (14 kept). One named volume, `hivemind-data`, mounted at `/app/data`. |
| `.dockerignore` | Keeps `.env`, `data/`, tests and documents out of the image. Secrets are never baked in. |

## Settings (all environment variables, set in `.env` or the shell)

| Variable | Default | Meaning |
|---|---|---|
| `GROQ_API_KEY`, `OPENAI_API_KEY` | none | Model keys. With Claude switched off (the default) Groq and OpenAI do all the work. |
| `HIVEMIND_AUTO` | `0` | `0` = dashboard only, nothing is collected or sent to a model until someone presses a button. `1` = scheduled collection, background follow-ups, and the print editions once a day from 11:15 (`ocr.dailyAt` in `config/hivemind.json`). |
| `HIVEMIND_SCHEDULE_MINUTES` | `480` | Collection interval when `HIVEMIND_AUTO=1` (480 = three times a day). |
| `HIVEMIND_ADMIN_EMAIL` | empty | **Set this on any server other people can reach.** Only this address can create the first (administrator) account. Unset, whoever opens the page first becomes the administrator. |
| `HIVEMIND_ALLOWED_HOSTS` | empty | Host names the server answers to, comma separated (`localhost` always works). Needed behind a proxy or a domain; a request for any other host is refused (protection against DNS rebinding). |
| `HIVEMIND_COOKIE_SECURE` | `0` | `1` when users reach it over HTTPS. (An `X-Forwarded-Proto: https` header from a proxy has the same effect.) |
| `HIVEMIND_HOST` / `PORT` | `0.0.0.0` / `8788` in the image | Bind address and port. Outside Docker the default stays `127.0.0.1`. |
| `HIVEMIND_PORT` | `8788` | Port published on the host by compose. |
| `HIVEMIND_BODY_PROXY` | empty | Proxy used **only** to retry an article's text after a direct fetch failed (everything else connects directly). Also read: `DATAIMPULSE_PROXY_URL`, `HTTPS_PROXY`. `HIVEMIND_NO_PROXY=1` disables it. |
| `HIVEMIND_ALLOW_INSECURE_TLS` | unset | Certificate checking is always switched on at start-up. Set to `1` only on a network that needs it off. |

The compose file publishes the port on `127.0.0.1` only. To let other people in, put an HTTPS reverse proxy in front (Caddy, nginx or a cloud load balancer), set `HIVEMIND_ALLOWED_HOSTS` to its domain, and set `HIVEMIND_ADMIN_EMAIL`.

## State and backups

Everything that must survive lives under `/app/data`: the SQLite database, the raw print editions, the company files, the topic registry and the backups. **Mount a volume there.** Without one, the data is lost with the container.

* Automatic: the `backup` service runs `node src/cli.mjs backup --keep 14` daily. Copies land in `data/backups/`.
* By hand: `docker compose exec app node --no-warnings src/cli.mjs backup`
* The copies sit in the same volume as the database, which protects against a bad deployment or a mistaken command but not against losing the disk. **Copy them off the machine** (for example `docker cp` to a bucket) as well.
* Restore: stop the stack, copy a backup over `data/hivemind.db` in the volume, start it.

## Useful commands

```bash
docker compose exec app node --no-warnings src/cli.mjs ocr          # download and judge the print editions (Groq / Luna only)
docker compose exec app node --no-warnings src/cli.mjs run          # one collection
docker compose ps                                                   # health shows (healthy) once /healthz answers
curl http://localhost:8788/healthz                                  # {"ok":true}
```

## Known limits of this container

* **One instance only.** SQLite is a single-writer file; do not run two copies of `app` against the same volume.
* **API keys entered in the dashboard are lost on restart.** The Settings page writes them to a `.env` file inside the container. Provide keys through environment variables (`.env` next to the compose file, or a secret manager) instead.
* **Jobs run inside the server container** (the server starts them as child processes). Fine on one machine; the cloud plan moves them out (see `GCP-ROADMAP.md`).

## What was verified

Built the image; started it with a fresh volume and no API keys; it became healthy in 5 seconds; ran as `node` with `tini` as PID 1; `/healthz` returned ok, also for a foreign Host header; `/api/overview` returned 401 without a login and 403 for a foreign host; a stranger's sign-up was refused and the configured administrator's accepted; the account survived a container restart; the `backup` command worked inside the container; `docker stop` exited with code 0 after logging `SIGTERM: shutting down`.

Not tested: the `docker-compose.yml` itself (the checks above used `docker run` with the same settings, to be sure no real key could enter a test container).
