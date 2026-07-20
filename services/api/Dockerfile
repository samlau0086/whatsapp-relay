FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY services/api/package.json services/api/package-lock.json ./
RUN npm ci --ignore-scripts
COPY services/api/tsconfig.json ./
COPY services/api/src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-noto-core fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY infra/postgres/migrations ./migrations
USER node
CMD ["node","dist/server.js"]
