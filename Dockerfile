FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "dist/src/server.js"]
