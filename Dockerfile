FROM node:24-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
COPY scripts/copy-prisma-client.mjs ./scripts/
RUN npx prisma generate && npm run build

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
# renderTemplate deliberately resolves templates relative to the application cwd.
COPY --from=build --chown=node:node /app/src/services/mail/templates ./src/services/mail/templates
ENV NODE_ENV=production
USER node
EXPOSE 8000
CMD ["node", "dist/server.js"]
