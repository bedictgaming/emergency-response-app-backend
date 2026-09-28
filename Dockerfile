FROM node:24-bookworm-slim
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
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "dist/server.js"]
