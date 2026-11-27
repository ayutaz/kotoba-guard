# Dependency image for scripts/harness/linux_validation.py.
#
# This image deliberately contains no repository source, model, browser, or
# cache. The launcher copies only /workspace/.venv and
# /workspace/node_modules into an isolated workspace created from a clean git
# archive.
FROM node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d

ARG UV_VERSION=0.12.20

ENV CI=true \
    UV_CACHE_DIR=/tmp/uv-cache \
    UV_PYTHON=3.12 \
    npm_config_cache=/tmp/npm-cache \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    PYTHONIOENCODING=utf-8

WORKDIR /workspace

# These are the only files allowed through the root .dockerignore.  The
# workspace package manifest is required for npm ci; no source code is copied.
COPY pyproject.toml uv.lock package.json package-lock.json .python-version .node-version README.md ./
COPY packages/core/package.json packages/core/package.json

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl python3 \
    && curl --fail --silent --show-error --location \
      https://astral.sh/uv/${UV_VERSION}/install.sh --output /tmp/uv-install.sh \
    && UV_INSTALL_DIR=/usr/local/bin UV_VERSION=${UV_VERSION} sh /tmp/uv-install.sh \
    && rm -f /tmp/uv-install.sh \
    && apt-get purge --yes curl \
    && apt-get autoremove --yes \
    && rm -rf /var/lib/apt/lists/*

RUN uv sync --locked \
    && npm ci \
    && rm -rf /tmp/uv-cache /tmp/npm-cache /root/.cache

LABEL org.opencontainers.image.title="Kotoba Guard Linux validation dependencies" \
      org.opencontainers.image.source="https://github.com/ayutaz/kotoba-guard" \
      org.opencontainers.image.description="Pinned dependency image; models and source are mounted by the validation launcher"
