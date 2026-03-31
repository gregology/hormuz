FROM python:3.12-slim

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

COPY pyproject.toml .
COPY src/ src/

# Verify codegen ran before docker build (generated files are gitignored,
# so the build host must run: pnpm generate && pnpm generate:coastlines && pnpm generate:heightmap)
RUN test -f src/hormuz/generated/__init__.py || \
    (echo "ERROR: server/src/hormuz/generated/ is missing. Run 'pnpm generate && pnpm generate:coastlines && pnpm generate:heightmap' before building." && exit 1)

RUN uv sync --no-dev

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "hormuz.main:app", "--host", "0.0.0.0", "--port", "8000"]
