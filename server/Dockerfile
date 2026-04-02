# Build context must be the repo root:
#   docker build -t hormuz-server:latest -f server/Dockerfile .

# --- Stage 1: generate Python code from YAML + geographic data ---
FROM python:3.12-slim AS codegen

WORKDIR /build
COPY shared/ shared/

# Create output directories the scripts expect
RUN mkdir -p server/src/hormuz/generated client/src/generated client/src/map

RUN pip install --no-cache-dir pyyaml shapely requests numpy scipy

RUN python shared/scripts/generate.py && \
    python shared/scripts/generate_coastlines.py && \
    python shared/scripts/generate_heightmap.py

# --- Stage 2: server image ---
FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY server/pyproject.toml .
COPY server/src/ src/
COPY --from=codegen /build/server/src/hormuz/generated/ src/hormuz/generated/

RUN uv sync --no-dev

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "hormuz.main:app", "--host", "0.0.0.0", "--port", "8000"]
