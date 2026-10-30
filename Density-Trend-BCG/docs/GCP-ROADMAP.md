# HiveMind on Google Cloud: roadmap

Status of this document: a plan. The container (`Dockerfile`, `docker-compose.yml`) and the PostgreSQL schema and migration were built and tested on a laptop (see `DOCKER.md`, `POSTGRES-MIGRATION.md`). **Nothing here has been run on GCP.** Commands are drafts to adapt; costs are rough list-price guesses to check with the Google Cloud pricing calculator.

## 1. Where the application stands (facts from the code)

| Fact | Consequence for the cloud |
|---|---|
| Data is a SQLite file (93 MB) written by the server and by job processes | Needs one disk and one instance. Cloud Run (stateless, several instances) cannot use it. |
| The server starts jobs (`run`, `ocr`, enrich...) as child processes of itself | Fine on a VM. On Cloud Run, jobs should be separate Cloud Run Jobs. |
| Some state is in files: company and sector files, the topic registry, weight overrides, raw print editions (16 MB), and `.env` (written when keys are entered in Settings) | These must move to the database or a bucket before Cloud Run; keys must come from Secret Manager. |
| Login, sessions, CSRF protection, security headers, host allow-list, `X-Forwarded-Proto` support already exist | Good base for a public service. Needs `HIVEMIND_ALLOWED_HOSTS` and `HIVEMIND_ADMIN_EMAIL` set. |
| `/healthz`, SIGTERM shutdown, configurable bind address, daily backup command: added and tested | Ready for load balancers, Cloud Run and managed instance restarts. |
| Background timers run inside the server (matching every 8 s, snapshots every 5 min, forecast checks every 30 min) | On Cloud Run these need "CPU always allocated", or to move to Scheduler-triggered jobs. |
| Models: Groq and OpenAI (Luna) with Claude switched off, a daily Luna spend cap | Keys go in Secret Manager. Outbound internet access is required (no private-only network). |
| Dashboard load: first Opportunities load 22.9 s, now 0.7 s | Already fixed; not a reason to change database. |

## 2. Target

```
 users ──HTTPS──> Cloud Load Balancer (managed certificate, Cloud Armor)
                        │
                 Cloud Run: hivemind-web  ──────────────┐   Secret Manager (API keys)
                  (min 1 instance, /healthz)            │
                        │ Cloud SQL connector           │
                 Cloud SQL for PostgreSQL ◄─────────────┤
                  (automatic backups, PITR)             │
                        ▲                               │
 Cloud Scheduler ─> Cloud Run Jobs: collect, ocr, backup-export ──> Cloud Storage (raw print editions, exports)
                                                        │
                      Cloud Logging / Monitoring / alerts on /healthz, job failures, spend
```

Region: **asia-south1 (Mumbai)**, the closest to the readers and the Indian news sources (asia-south2 Delhi is the alternative). Decide once; moving a database later is work.

## 3. Phases

### Phase 0: before any cloud work (days)
* Commit and push the work (28 files are uncommitted). Branch protection on `main`.
* CI that runs the 146 tests and builds the image on every push (GitHub Actions or Cloud Build).
* Rotate the OpenAI key that was pasted into a chat. Move keys out of `.env` into a password manager first.
* Off-machine copy of the daily backup.
* **Done:** the Dockerfile, compose file, health check, backup command, first-admin lock and the 22-second load fix.

### Phase 1: one virtual machine (3 to 5 days)
The fastest way to a real, reachable deployment, and it needs **no code change**: SQLite stays, on a persistent disk.

1. Compute Engine VM in asia-south1: e2-standard-2 (2 vCPU, 8 GB) is plenty; Container-Optimized OS or Ubuntu; a 50 GB SSD persistent disk for `/var/lib/docker/volumes`; a reserved static IP.
2. **Daily disk snapshot schedule** (14 days kept) on top of the app's own daily backup.
3. HTTPS: Caddy in front (automatic certificates) or an HTTPS load balancer with a managed certificate. Set `HIVEMIND_ALLOWED_HOSTS=hivemind.example.com`, `HIVEMIND_COOKIE_SECURE=1`, `HIVEMIND_ADMIN_EMAIL=you@example.com`.
4. Secrets: Secret Manager, read at VM start by the VM's own service account and passed to compose as environment variables. No key on disk.
5. Firewall: only 80/443 open; SSH through Identity-Aware Proxy, not the public internet.
6. Monitoring: an uptime check on `https://host/healthz`, an alert on failure, the Ops Agent for logs and memory, a billing budget alert.
7. Deploy: `docker compose pull && docker compose up -d` from a small script; a tagged image in Artifact Registry.

Draft commands (not run):
```bash
gcloud compute instances create hivemind --zone=asia-south1-a --machine-type=e2-standard-2 \
  --image-family=cos-stable --image-project=cos-cloud --boot-disk-size=50GB --boot-disk-type=pd-ssd \
  --address=hivemind-ip --tags=https --service-account=hivemind-vm@PROJECT.iam.gserviceaccount.com --scopes=cloud-platform
gcloud compute resource-policies create snapshot-schedule hivemind-daily --region=asia-south1 \
  --daily-schedule --start-time=21:00 --max-retention-days=14
gcloud compute firewall-rules create allow-https --allow=tcp:80,tcp:443 --target-tags=https
```
**Done when:** the dashboard is reachable over HTTPS by the team, a stranger cannot become administrator, a restored snapshot has been tried once, and an alert fires when the container is stopped on purpose.
**Cost (guess):** about 40 to 70 USD a month for the VM, disk, snapshots and static IP; more if an HTTPS load balancer is used.

### Phase 2: PostgreSQL (2 to 4 weeks, the real engineering)
Only when more than one instance or managed backups are needed. Follow `POSTGRES-MIGRATION.md`: make the store asynchronous (130 methods, 280 call sites), add the PostgreSQL implementation, run all tests against both, versioned migrations, rehearse the cut-over with `migrate-sqlite-to-postgres.mjs` (90,370 rows in 9.4 s; checks built in).
* Cloud SQL for PostgreSQL 17, private IP, automatic backups, point-in-time recovery, maintenance window set; start with a small shared-core or 1 vCPU instance, add a standby (high availability) once it is business-critical.
* **Done when:** the whole test suite passes on both databases, a restore from a Cloud SQL backup has been rehearsed, and the VM from Phase 1 runs against Cloud SQL for a week with no incident.
* **Cost (guess):** about 10 to 50 USD a month for a small instance; roughly double with a standby.

### Phase 3: Cloud Run (1 to 2 weeks after Phase 2)
1. **Move the files.** Company/sector files, the topic registry and weight overrides into database tables; raw print editions to a Cloud Storage bucket; the Settings page stops writing `.env` (keys come only from Secret Manager).
2. **Split the work.** `hivemind-web`: a Cloud Run service from the same image, minimum 1 instance, CPU always allocated (the background timers need it), `/healthz` as startup and liveness probe, connected to Cloud SQL with the Cloud SQL connector. `collect`, `ocr` and `backup-export`: Cloud Run **Jobs** from the same image, triggered by **Cloud Scheduler** (three collections a day) and by the Run button (the server calls the Jobs API instead of spawning a child process, the one real code change here).
3. **Front door.** A global HTTPS load balancer with a managed certificate; Cloud Armor rate limits; either the app's own login or **Identity-Aware Proxy** (Google sign-in) if the users are all in one Google Workspace.
4. **Identity.** One service account per component with the minimum roles (Cloud SQL Client, Secret Accessor for the keys it needs, Storage Object Admin on its bucket only).
5. **Cut over** with the web service reading the same Cloud SQL as the VM, then retire the VM.
* **Done when:** a deploy is a command with no downtime, a failed job alerts and retries, and no component writes to local disk.
* **Cost (guess):** 20 to 50 USD a month for the web service with one always-on instance; jobs and Scheduler are small.

### Phase 4: run it like a product (ongoing)
* CI/CD: build, test, push to Artifact Registry, deploy to a **staging** Cloud Run service, smoke test, then production; infrastructure as code (Terraform).
* Alerts: `/healthz` down, job failures, error-rate rise, database CPU and storage, model spend near its cap, the 'no print editions read for 24 h' condition.
* Quality: hand-label about 200 articles to measure the real accuracy of the opinion/analysis labels and the page-layout step; set thresholds from that, not from agreement between models.
* Security: dependency and image scanning, a penetration test, a quarterly restore drill, a documented key-rotation routine.
* Data governance: write down what text goes to which model provider (article text to Groq and OpenAI; client sector names to the matching job) and whether the clients accept that.
* Cost control: billing budgets, the existing daily Luna cap, a monthly review of the usage panel.

## 4. Decisions needed from you

1. **Who uses it?** Only the team (then IAP or the app's login is enough) or outside clients (then a stronger isolation story, per-client data separation, and a pen test before launch).
2. **How reliable must it be?** A morning outage acceptable (Phase 1 is enough) or not (Phase 2 with a standby and Phase 3).
3. **Region and data residency**, Mumbai or Delhi, and whether any data may leave India (article text already goes to US-based model providers).
4. **Budget ceiling** per month for infrastructure and for model calls separately.
5. **Domain name** and who owns the DNS.
6. **Is a staging environment wanted?** (Recommended from Phase 3.)

## 5. Risks and how to reduce them

| Risk | Reduction |
|---|---|
| The Phase 2 rewrite breaks behaviour | Do the interface step alone first with all 146 tests unchanged; run the suite against both databases. |
| A destructive command with no backup (it has happened once in development) | Backups before any `--reassemble`-type command; snapshots; restore drills. |
| Model keys leak | Secret Manager, no keys on disk or in images, rotation routine, daily spend caps. |
| A stranger takes the administrator account | `HIVEMIND_ADMIN_EMAIL` set before the first start (tested). |
| Groq or OpenAI outages or limits | Fallback order exists (Luna to Groq); alert on error rates; keep the Claude switch available as a manual fallback. |
| Cost surprise | Budget alerts, the Luna cap, scale-to-zero for staging. |
| Quality is assumed, not measured | The hand-labelled sample in Phase 4. |

## 6. Rough timeline (estimates)

| Phase | Effort | Result |
|---|---|---|
| 0 | 2 to 3 days | Work in git, CI green, key rotated |
| 1 | 3 to 5 days | Live on HTTPS, backed up, monitored |
| 2 | 2 to 4 weeks | PostgreSQL in production |
| 3 | 1 to 2 weeks | Cloud Run, jobs on a schedule, no single machine |
| 4 | continuous | Measured quality, alerts, staging, governance |

Phase 1 alone is a defensible production step for a small team. Phases 2 and 3 are worth the cost when the number of users, the uptime requirement or the deploy frequency outgrows one machine.
