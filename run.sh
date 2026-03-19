#!/bin/bash

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Defaults
NIKKO_CHROME_USERNAME=""
NIKKO_CHROME_PASSWORD=""
RUN_IN_SCREEN="false"
SESSION_NAME="chrome-fleet"
REST_API="false"
REST_API_KEY=""
AUTO_INSTALL="false"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

normalize_bool() {
  case "${1:-false}" in
    1|true|TRUE|True|yes|YES|on|ON) echo "true" ;;
    *) echo "false" ;;
  esac
}

shell_escape() {
  printf '%q' "$1"
}

resolve_binary() {
  local candidate="$1"

  if [ -z "$candidate" ]; then
    return 1
  fi

  if [[ "$candidate" == */* ]]; then
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
    return 1
  fi

  if command -v "$candidate" >/dev/null 2>&1; then
    command -v "$candidate"
    return 0
  fi

  return 1
}

resolve_node_bin() {
  local candidate
  local resolved
  for candidate in "${NODE_BIN:-}" node /opt/homebrew/opt/node@22/bin/node /usr/local/bin/node /usr/bin/node; do
    if resolved="$(resolve_binary "$candidate")" && "$resolved" --version >/dev/null 2>&1; then
      echo "$resolved"
      return 0
    fi
  done
  return 1
}

# Helper: Parse arguments (format KEY=VALUE)
for ARGUMENT in "$@"; do
  KEY=$(echo "$ARGUMENT" | cut -f1 -d=)
  KEY_LENGTH=${#KEY}
  VALUE="${ARGUMENT:$KEY_LENGTH+1}"
  export "$KEY"="$VALUE"
done

RUN_IN_SCREEN=$(normalize_bool "${RUN_IN_SCREEN:-false}")
REST_API=$(normalize_bool "${REST_API:-false}")
AUTO_INSTALL=$(normalize_bool "${AUTO_INSTALL:-false}")

# Default Port if not set
if [ -z "${PORT:-}" ]; then
  PORT=3000
fi

# Chrome manager runtime defaults (can be overridden via args)
# Per-instance "Use Xvfb / Headless" is now authoritative for local spawns.
if [ -z "${CHROME_MANAGER_FORCE_HEADLESS:-}" ]; then
  CHROME_MANAGER_FORCE_HEADLESS=0
fi
if [ -z "${CHROME_MANAGER_ENABLE_WEBGL:-}" ]; then
  CHROME_MANAGER_ENABLE_WEBGL=1
fi

# Check Auth
if [ -z "${USERNAME:-}" ] || [ -z "${PASSWORD:-}" ]; then
  echo -e "${RED}Error: USERNAME and PASSWORD are required.${NC}"
  echo "Usage: ./run.sh USERNAME=admin PASSWORD=secret [PORT=3000] [RUN_IN_SCREEN=true] [REST_API=true] [REST_API_KEY=secret] [AUTO_INSTALL=true] [CHROME_MANAGER_FORCE_HEADLESS=0] [CHROME_MANAGER_ENABLE_WEBGL=1]"
  exit 1
fi

if [ "$REST_API" = "true" ] && [ -z "${REST_API_KEY:-}" ]; then
  echo -e "${RED}Error: REST_API=true requires REST_API_KEY.${NC}"
  echo "Usage: ./run.sh USERNAME=admin PASSWORD=secret REST_API=true REST_API_KEY=super-secret"
  exit 1
fi

export NIKKO_CHROME_USERNAME="$USERNAME"
export NIKKO_CHROME_PASSWORD="$PASSWORD"
export PORT="$PORT"
export REST_API="$REST_API"
export REST_API_KEY="${REST_API_KEY:-}"
export CHROME_MANAGER_FORCE_HEADLESS="$CHROME_MANAGER_FORCE_HEADLESS"
export CHROME_MANAGER_ENABLE_WEBGL="$CHROME_MANAGER_ENABLE_WEBGL"

NODE_BIN_RESOLVED="$(resolve_node_bin)" || {
  echo -e "${RED}Error: working Node.js binary not found.${NC}"
  exit 1
}
export NODE_BIN="$NODE_BIN_RESOLVED"

echo -e "${GREEN}>>> Chrome Fleet Control Launcher <<<${NC}"
echo "User: $NIKKO_CHROME_USERNAME"
echo "Port: $PORT"
echo "REST_API: $REST_API"
echo "Node: $NODE_BIN"
echo "CHROME_MANAGER_FORCE_HEADLESS (legacy env): $CHROME_MANAGER_FORCE_HEADLESS"
echo "CHROME_MANAGER_ENABLE_WEBGL: $CHROME_MANAGER_ENABLE_WEBGL"

if [ -x "$SCRIPT_DIR/prep.sh" ]; then
  echo "Running prep.sh..."
  "$SCRIPT_DIR/prep.sh" AUTO_INSTALL="$AUTO_INSTALL" REQUIRE_SCREEN="$RUN_IN_SCREEN" RUN_NPM_INSTALL=true
  PREP_STATUS=$?
  if [ $PREP_STATUS -ne 0 ]; then
    echo -e "${RED}prep.sh failed. Please resolve the missing requirements first.${NC}"
    exit $PREP_STATUS
  fi
else
  echo -e "${YELLOW}Warning: prep.sh not found or not executable. Skipping environment preparation.${NC}"
fi

if [ "$RUN_IN_SCREEN" = "true" ]; then
  if ! command -v screen >/dev/null 2>&1; then
    echo -e "${RED}Error: 'screen' is required for RUN_IN_SCREEN=true.${NC}"
    exit 1
  fi

  if screen -ls | grep -q "\.${SESSION_NAME}[[:space:]]"; then
    echo -e "${YELLOW}Session '$SESSION_NAME' is already running.${NC}"
    echo "Attach with: screen -r $SESSION_NAME"
    exit 0
  fi

  echo "Starting server in screen session '$SESSION_NAME'..."
  SCREEN_COMMAND="cd $(shell_escape "$SCRIPT_DIR"); export PATH=$(shell_escape "$PATH"); export NIKKO_CHROME_USERNAME=$(shell_escape "$USERNAME"); export NIKKO_CHROME_PASSWORD=$(shell_escape "$PASSWORD"); export PORT=$(shell_escape "$PORT"); export REST_API=$(shell_escape "$REST_API"); export REST_API_KEY=$(shell_escape "${REST_API_KEY:-}"); export CHROME_MANAGER_FORCE_HEADLESS=$(shell_escape "$CHROME_MANAGER_FORCE_HEADLESS"); export CHROME_MANAGER_ENABLE_WEBGL=$(shell_escape "$CHROME_MANAGER_ENABLE_WEBGL"); export NODE_BIN=$(shell_escape "$NODE_BIN"); $(shell_escape "$NODE_BIN") server.js; echo 'Server stopped. Press any key to exit screen.'; read -n 1"

  screen -dmS "$SESSION_NAME" bash -lc "$SCREEN_COMMAND"

  sleep 1
  if screen -ls | grep -q "\.${SESSION_NAME}[[:space:]]"; then
    echo -e "${GREEN}Server started in background!${NC}"
    echo "Attach command: screen -r $SESSION_NAME"
  else
    echo -e "${RED}Failed to start screen session. Try running without RUN_IN_SCREEN=true to see errors.${NC}"
    exit 1
  fi
else
  echo "Starting server in foreground..."
  "$NODE_BIN" server.js
fi
