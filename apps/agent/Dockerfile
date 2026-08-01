FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY apps/agent/package.json apps/agent/package-lock.json ./
RUN npm ci --ignore-scripts
COPY apps/agent/tsconfig.json ./
COPY apps/agent/scripts ./scripts
COPY apps/agent/src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production RELAY_DATA_DIR=/data
COPY apps/agent/package.json apps/agent/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
USER node
VOLUME ["/data"]
CMD ["npm", "run", "start:docker"]
