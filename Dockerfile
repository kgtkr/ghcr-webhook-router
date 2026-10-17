FROM --platform=$BUILDPLATFORM node:24-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
USER node

COPY --from=builder --chown=node:node /app/dist/index.mjs ./dist/index.mjs

EXPOSE 3000

CMD ["node", "dist/index.mjs"]
