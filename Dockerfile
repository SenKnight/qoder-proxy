# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
COPY package.json ./
# Only dev dependencies are needed; the relay has no runtime npm deps.
# --legacy-peer-deps works around an npm 10 arborist bug with vitest 4 peer sets.
RUN npm install --legacy-peer-deps --no-audit --no-fund
COPY tsconfig.json biome.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
EXPOSE 8787
# Bind to all interfaces inside the container so the port can be published.
ENV HOST=0.0.0.0
ENTRYPOINT ["node", "dist/index.js"]
