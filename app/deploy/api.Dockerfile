FROM node:22-alpine
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate && apk add --no-cache poppler-utils wget
WORKDIR /repo
# every workspace manifest, so pnpm sees a complete workspace whichever package is selected
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY apps/executor/package.json apps/executor/
COPY packages/finance/package.json packages/finance/
COPY packages/parsers/package.json packages/parsers/
COPY packages/connectors/package.json packages/connectors/
COPY packages/reports/package.json packages/reports/
# "@fo/api..." selects the api and its workspace dependencies, so their devDependencies (typescript) are installed too
RUN pnpm install --frozen-lockfile --filter @fo/api... --dangerously-allow-all-builds
COPY packages/finance packages/finance
COPY packages/parsers packages/parsers
COPY packages/connectors packages/connectors
COPY packages/reports packages/reports
COPY apps/api apps/api
# topological: every dependency builds before the api, and a new one is picked up without editing this file
RUN pnpm --filter @fo/api... build
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /repo
USER app
WORKDIR /repo/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]
