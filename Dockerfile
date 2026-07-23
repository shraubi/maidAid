FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --include=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

USER node
EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
