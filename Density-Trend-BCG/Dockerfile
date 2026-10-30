# HiveMind: one image for the dashboard server and for the one-off jobs (collect, ocr, backup...), because the server starts the jobs from
# the same code. There is nothing to compile and no npm packages to install: Node's own SQLite and fetch are used.
#
#   docker build -t hivemind .
#   docker run --rm -p 127.0.0.1:8788:8788 -v hivemind-data:/app/data -e HIVEMIND_AUTO=0 hivemind
#
# State lives in /app/data (the SQLite database, raw print editions, company files, backups). Mount a volume there or it is lost with the container.

FROM node:24-slim

ENV NODE_ENV=production \
    PORT=8788 \
    HIVEMIND_HOST=0.0.0.0

# tini is the init process: it passes SIGTERM on to the server (so `docker stop` shuts it down cleanly) and reaps the job processes it starts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node config ./config
COPY --chown=node:node src ./src

# the data folder must exist and belong to the unprivileged user, also when a fresh volume is mounted over it
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 8788

# /healthz needs no login and answers for any host name, so it works for Docker, Cloud Run and load balancers alike.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "src/cli.mjs", "serve"]
