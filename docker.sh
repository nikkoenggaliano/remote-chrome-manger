#!/usr/bin/env bash
# ============================================================================
# Chrome Fleet Control — one-file Docker deploy
# ----------------------------------------------------------------------------
# `./docker.sh` builds the image (bundled Chromium + all runtime helpers) and
# brings the dashboard up — ready to use, no host dependencies beyond Docker.
#
# It transparently supports every Docker flavour:
#   1. `docker compose`   (Compose V2 plugin)      — preferred
#   2. `docker-compose`   (legacy standalone V1)   — fallback
#   3. plain `docker`     (no Compose at all)       — last-resort fallback
#
# Usage:
#   ./docker.sh [up]        Build (if needed) and start in the background (default)
#   ./docker.sh down        Stop and remove the container
#   ./docker.sh restart     Restart the container
#   ./docker.sh build       Build/rebuild the image only
#   ./docker.sh logs        Follow container logs
#   ./docker.sh status      Show container status
#   ./docker.sh shell       Open a shell inside the running container
#   ./docker.sh export      Save the image to ./deploy for offline import
#   ./docker.sh load        Load an image tar from ./deploy
#   ./docker.sh help        Show this help
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="chrome-fleet-control:latest"
CONTAINER_NAME="chrome-fleet-control"
SERVICE_NAME="chrome-fleet"
DEPLOY_DIR="$SCRIPT_DIR/deploy"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}INFO${NC} $*"; }
ok()    { echo -e "${GREEN}OK${NC}   $*"; }
warn()  { echo -e "${YELLOW}WARN${NC} $*"; }
err()   { echo -e "${RED}ERR${NC}  $*" >&2; }

# ---------------------------------------------------------------------------
# Detect Docker + the available Compose flavour.
# ---------------------------------------------------------------------------
COMPOSE=""          # command used to talk to compose ("" when unavailable)
MODE=""             # "compose" or "plain"

detect_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker is not installed or not on PATH. Install Docker first: https://docs.docker.com/get-docker/"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "Docker is installed but the daemon is not reachable. Start Docker (Desktop/colima/service) and retry."
    exit 1
  fi

  if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"; MODE="compose"
    info "Using Docker Compose plugin: 'docker compose'"
  elif command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    COMPOSE="docker-compose"; MODE="compose"
    info "Using legacy Compose binary: 'docker-compose'"
  else
    MODE="plain"
    warn "No Docker Compose found — falling back to plain 'docker' commands."
  fi
}

# ---------------------------------------------------------------------------
# First-run bootstrap: .env + persistent data locations.
# ---------------------------------------------------------------------------
ensure_env() {
  if [ ! -f "$SCRIPT_DIR/.env" ]; then
    if [ -f "$SCRIPT_DIR/.env.example" ]; then
      cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
      warn "No .env found — created one from .env.example. Review credentials in $SCRIPT_DIR/.env"
    else
      err "Neither .env nor .env.example found; cannot continue."
      exit 1
    fi
  fi
}

ensure_data() {
  # Bind-mount targets must pre-exist with the right type: a directory for
  # profiles, and a FILE for the sqlite db (else Docker creates a directory).
  mkdir -p "$SCRIPT_DIR/data/profiles"
  [ -e "$SCRIPT_DIR/data/database.sqlite" ] || : > "$SCRIPT_DIR/data/database.sqlite"
}

# Read a KEY from .env (last definition wins). Strips surrounding quotes.
# Only used for display/port hints (PORT, username) — not for secrets.
env_get() {
  local key="$1" line
  [ -f "$SCRIPT_DIR/.env" ] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$SCRIPT_DIR/.env" 2>/dev/null | tail -n1)" || return 0
  [ -n "$line" ] || return 0
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

host_port() {
  local p; p="$(env_get PORT)"; echo "${p:-3000}"
}

# ---------------------------------------------------------------------------
# Plain-docker equivalents of the compose service (used when no Compose exists).
# ---------------------------------------------------------------------------
plain_build() {
  info "Building image ${IMAGE_NAME} ..."
  docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"
  ok "Image built."
}

plain_up() {
  # (Re)build unless the image already exists and NO_BUILD is set.
  if [ "${NO_BUILD:-0}" != "1" ] || ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    plain_build
  fi
  local port; port="$(host_port)"
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  info "Starting container ${CONTAINER_NAME} on host port ${port} ..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file "$SCRIPT_DIR/.env" \
    -e CHROME_BIN=/headless-shell/headless-shell \
    -e CHROME_MANAGER_ENABLE_WEBGL=1 \
    -e PORT=3000 \
    -p "${port}:3000" \
    --shm-size=2g \
    -v "$SCRIPT_DIR/.env:/app/.env" \
    -v "$SCRIPT_DIR/data/profiles:/app/profiles" \
    -v "$SCRIPT_DIR/data/database.sqlite:/app/database.sqlite" \
    "$IMAGE_NAME" >/dev/null
  ok "Container started."
}

# ---------------------------------------------------------------------------
# Command implementations (dispatch on MODE).
# ---------------------------------------------------------------------------
cmd_up() {
  ensure_env; ensure_data
  if [ "$MODE" = "compose" ]; then
    info "Building and starting via ${COMPOSE} ..."
    $COMPOSE up -d --build
  else
    plain_up
  fi
  print_ready
}

cmd_build() {
  ensure_env; ensure_data
  if [ "$MODE" = "compose" ]; then $COMPOSE build; else plain_build; fi
}

cmd_down() {
  if [ "$MODE" = "compose" ]; then
    $COMPOSE down
  else
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 && ok "Removed ${CONTAINER_NAME}." || warn "No container to remove."
  fi
}

cmd_restart() {
  if [ "$MODE" = "compose" ]; then $COMPOSE restart; else docker restart "$CONTAINER_NAME"; fi
  print_ready
}

cmd_logs() {
  if [ "$MODE" = "compose" ]; then $COMPOSE logs -f --tail=100; else docker logs -f --tail=100 "$CONTAINER_NAME"; fi
}

cmd_status() {
  if [ "$MODE" = "compose" ]; then
    $COMPOSE ps
  else
    docker ps -a --filter "name=^/${CONTAINER_NAME}$" \
      --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
  fi
}

cmd_shell() {
  docker exec -it "$CONTAINER_NAME" bash
}

# Save the built image into ./deploy so it can be imported on an offline host.
cmd_export() {
  ensure_env; ensure_data
  info "Ensuring image is built before export ..."
  if [ "$MODE" = "compose" ]; then $COMPOSE build; else plain_build; fi

  mkdir -p "$DEPLOY_DIR"
  local arch tar
  arch="$(docker image inspect "$IMAGE_NAME" --format '{{.Architecture}}' 2>/dev/null || echo unknown)"
  tar="$DEPLOY_DIR/chrome-fleet-control-${arch}.tar.gz"

  info "Saving ${IMAGE_NAME} (${arch}) -> ${tar} ..."
  docker save "$IMAGE_NAME" | gzip > "$tar"
  ok "Exported image: ${tar} ($(du -h "$tar" | cut -f1))"
  info "Copy the whole ./deploy folder to the offline machine, then run ./deploy/load.sh there."
}

# Load an image tar from ./deploy (for the offline machine).
cmd_load() {
  local tar
  tar="$(ls -1 "$DEPLOY_DIR"/chrome-fleet-control-*.tar.gz 2>/dev/null | head -n1 || true)"
  [ -n "$tar" ] || { err "No image tar found in ${DEPLOY_DIR}. Expected chrome-fleet-control-*.tar.gz"; exit 1; }
  info "Loading image from ${tar} ..."
  gunzip -c "$tar" | docker load
  ok "Image loaded."
}

print_ready() {
  local port user; port="$(host_port)"; user="$(env_get CHROME_FLEET_USERNAME)"
  echo
  ok "Chrome Fleet Control is up."
  echo -e "  ${GREEN}URL:${NC}      http://localhost:${port}"
  echo -e "  ${GREEN}Login:${NC}    user='${user:-admin}' (password is CHROME_FLEET_PASSWORD in .env)"
  echo -e "  ${GREEN}Logs:${NC}     ./docker.sh logs"
  echo -e "  ${GREEN}Stop:${NC}     ./docker.sh down"
}

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
main() {
  local cmd="${1:-up}"
  case "$cmd" in
    help|-h|--help) usage; exit 0 ;;
  esac

  detect_docker
  case "$cmd" in
    up|"")     cmd_up ;;
    down|stop) cmd_down ;;
    restart)   cmd_restart ;;
    build)     cmd_build ;;
    logs)      cmd_logs ;;
    status|ps) cmd_status ;;
    shell|sh|bash) cmd_shell ;;
    export|save)   cmd_export ;;
    load|import)   cmd_load ;;
    *) err "Unknown command: $cmd"; echo; usage; exit 1 ;;
  esac
}

main "$@"
