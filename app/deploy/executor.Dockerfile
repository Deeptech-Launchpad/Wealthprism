FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY apps/executor/package.json apps/executor/
COPY packages/finance/package.json packages/finance/
COPY packages/parsers/package.json packages/parsers/
COPY packages/connectors/package.json packages/connectors/
COPY packages/reports/package.json packages/reports/
# "..." matters: @fo/connectors is built here, so its devDependencies (typescript) must be installed
RUN pnpm install --frozen-lockfile --filter @fo/executor... --dangerously-allow-all-builds
COPY packages/connectors packages/connectors
COPY apps/executor apps/executor
RUN pnpm --filter @fo/executor... build
ENV NODE_ENV=production
RUN addgroup -S exec && adduser -S exec -G exec && chown -R exec:exec /repo
USER exec
WORKDIR /repo/apps/executor
CMD ["node", "dist/executor.js"]
