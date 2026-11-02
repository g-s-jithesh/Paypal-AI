# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Bake the 50-dispute Golden Dataset into the image so the demo works with zero setup
RUN npm run build && npm run db:seed

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
# schema.sql is read at runtime by the reset endpoint; copy explicitly rather than relying on file tracing
COPY --from=builder --chown=node:node /app/db/schema.sql ./db/schema.sql
COPY --from=builder --chown=node:node /app/chargeback_shield.db ./chargeback_shield.db
USER node
EXPOSE 3000
CMD ["node", "server.js"]
