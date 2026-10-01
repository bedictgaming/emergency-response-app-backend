FROM node:24-bookworm-slim
WORKDIR /app
COPY server.mjs ./server.mjs
ENV NODE_ENV=production
EXPOSE 8000
CMD ["node", "server.mjs"]
