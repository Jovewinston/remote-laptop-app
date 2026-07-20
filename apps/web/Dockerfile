# Build from monorepo root: docker build -f apps/web/Dockerfile .
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/
COPY packages/shared/src ./packages/shared/src
COPY apps/web/package.json apps/web/tsconfig.json apps/web/next.config.ts ./apps/web/
COPY apps/web/src ./apps/web/src
COPY apps/web/next-env.d.ts ./apps/web/
# Copy host/connect package.json so the workspace lockfile resolves.
COPY host/package.json ./host/
COPY connect/package.json ./connect/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bay/shared build

ARG NEXT_PUBLIC_BAY_API=http://127.0.0.1:8788
ENV NEXT_PUBLIC_BAY_API=$NEXT_PUBLIC_BAY_API
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @bay/web build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3200

COPY --from=deps /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/web ./apps/web
COPY --from=deps /app/host/package.json ./host/
COPY --from=deps /app/connect/package.json ./connect/

EXPOSE 3200
CMD ["pnpm", "--filter", "@bay/web", "start"]
