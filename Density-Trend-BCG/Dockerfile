# HiveMind Enterprise Production Container (Node 24 Alpine/Slim + PostgreSQL client)
FROM node:24-slim

ENV NODE_ENV=production \
    PORT=8788 \
    HIVEMIND_HOST=0.0.0.0

# Install tini init and PostgreSQL client tools for backups
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates postgresql-client \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY config ./config
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--no-warnings", "src/cli.mjs", "serve"]
