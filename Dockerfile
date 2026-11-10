FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY data/metro-overpass.json ./data/metro-overpass.json
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "server/index.mjs"]
