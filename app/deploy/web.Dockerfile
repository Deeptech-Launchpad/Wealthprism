FROM node:22-alpine AS build
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
RUN pnpm install --frozen-lockfile --filter @fo/web... --dangerously-allow-all-builds
COPY apps/web apps/web
ARG VITE_API_URL=/api/v1
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @fo/web build
FROM nginx:1.27-alpine
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
