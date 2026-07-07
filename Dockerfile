# syntax=docker/dockerfile:1
# ============================================================================
# Chrome Fleet Control — container image
# ----------------------------------------------------------------------------
# Ships the Node dashboard together with a real browser (Chromium) and every
# runtime helper the app shells out to (socat, Xvfb, lsof). One image, ready to
# run — no host dependencies beyond Docker.
#
# Browser choice — why we base on chromedp/headless-shell:
#   * Google Chrome publishes no official linux/arm64 build.
#   * Debian's `chromium` package arm64 build SIGTRAPs at startup inside the
#     Linux VM that backs Docker on Apple Silicon.
#   * Google's official `chromedp/headless-shell` Chromium (multi-arch
#     amd64+arm64, Debian 13 "trixie") runs AND renders real pages cleanly.
#   * headless-shell is tightly coupled to the exact freetype/harfbuzz/ICU/glibc
#     versions in its trixie base; running the binary against a different
#     distro's libraries crashes the RENDERER during text shaping. So we base
#     the runtime image directly on chromedp/headless-shell and only add Node +
#     the few helper tools the app needs (socat is already present in the base).
# ============================================================================

# ---- Stage 1: build native node modules against the trixie glibc ------------
# Match the runtime's Debian 13 (trixie) glibc so the compiled better-sqlite3
# and the node binary load cleanly in the headless-shell base.
FROM node:22-trixie-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund \
    || npm install --omit=dev --no-audit --no-fund

# ---- Stage 2: runtime = Google headless-shell (trixie) + Node ---------------
FROM chromedp/headless-shell:latest AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    CHROME_BIN=/headless-shell/headless-shell \
    CHROME_MANAGER_ENABLE_WEBGL=1 \
    CHROME_MANAGER_IGNORE_CERT_ERRORS=1 \
    PORT=3000

# Helper tools the app shells out to. `socat` already ships in the base image.
#   lsof     - port ownership checks used by chrome-manager
#   xvfb     - virtual framebuffer for the "xvfb" launch mode
#   procps   - `ps` for per-instance memory accounting
#   tini     - PID 1 init that reaps orphaned Chrome children
#   fonts-*  - broader glyph coverage (emoji / CJK) when rendering pages
RUN apt-get update && apt-get install -y --no-install-recommends \
      lsof \
      xvfb \
      procps \
      tini \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# Node runtime, copied from the builder (same trixie glibc → loads cleanly).
COPY --from=builder /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# Pre-built dependency tree, then the application source.
COPY --from=builder /app/node_modules ./node_modules
COPY . .

# Runtime state dirs. /tmp/.X11-unix must be world-writable+sticky so Xvfb can
# create its socket for the "xvfb" launch mode.
RUN mkdir -p /app/profiles /app/data /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix

EXPOSE 3000

# Any HTTP response (including the 401 from Basic Auth) means the server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(0)).on('error',()=>process.exit(1))"

# tini as PID 1 → clean signal handling + reaping of Chrome/Xvfb/socat children.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
