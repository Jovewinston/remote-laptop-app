# Build from monorepo root: docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
COPY apps/web/package.json ./apps/web/
COPY host/package.json ./host/
COPY connect/package.json ./connect/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bay/shared build

ENV NODE_ENV=production
ENV BAY_DB_PATH=/data/bay.db
ENV BAY_API_HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

RUN mkdir -p /data

CMD ["sh", "-c", "pnpm --filter @bay/api seed && pnpm --filter @bay/api start"]
