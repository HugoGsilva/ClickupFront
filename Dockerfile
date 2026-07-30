FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    PORT=3000

WORKDIR /app

# Instala as dependências primeiro para aproveitar o cache de camadas do Docker.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY public ./public

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health > /dev/null || exit 1

CMD ["node", "src/server.js"]
