FROM python:3.12-slim AS codegen

WORKDIR /app

RUN pip install --no-cache-dir pyyaml shapely requests numpy scipy

# Coastline + heightmap scripts change rarely — cache this layer
COPY shared/scripts/generate_coastlines.py shared/scripts/generate_heightmap.py shared/scripts/
RUN python shared/scripts/generate_coastlines.py \
    && python shared/scripts/generate_heightmap.py

# Vehicle codegen changes often but is fast
COPY shared/ shared/
RUN python shared/scripts/generate.py

FROM node:22-slim AS build

WORKDIR /app

RUN npm install -g pnpm@9

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY client/package.json client/
COPY shared/ shared/

RUN pnpm install --frozen-lockfile

COPY client/ client/
COPY --from=codegen /app/client/src/generated/ client/src/generated/
COPY --from=codegen /app/client/src/map/coastlines.ts client/src/map/coastlines.ts
COPY --from=codegen /app/client/src/map/heightmap-data.ts client/src/map/heightmap-data.ts

RUN pnpm build:client

FROM nginx:alpine

COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80
