#!/bin/bash

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo -e "\033[0;31mError: .env file not found.\033[0m"
  echo "Please copy .env.example to .env and configure it before running."
  exit 1
fi

set -a
source "$SCRIPT_DIR/.env"
set +a

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

RUN_IN_SCREEN=$(normalize_bool "${RUN_IN_SCREEN:-false}")
REST_API=$(normalize_bool "${REST_API:-false}")
AUTO_INSTALL=$(normalize_bool "${AUTO_INSTALL:-false}")

# Default Port if not set
if [ -z "${PORT:-}" ]; then
  PORT=3000
fi

if [ -z "${CHROME_MANAGER_ENABLE_WEBGL:-}" ]; then
  export CHROME_MANAGER_ENABLE_WEBGL=1
fi

# Check Auth
if [ -z "${NIKKO_CHROME_USERNAME:-}" ] || [ -z "${NIKKO_CHROME_PASSWORD:-}" ]; then
  echo -e "${RED}Error: NIKKO_CHROME_USERNAME and NIKKO_CHROME_PASSWORD are required in .env.${NC}"
  exit 1
fi

if [ "$REST_API" = "true" ] && [ -z "${REST_API_KEY:-}" ]; then
  echo -e "${RED}Error: REST_API=true requires REST_API_KEY in .env.${NC}"
  exit 1
fi

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
echo "POP_UP_REAL_BROWSER: ${POP_UP_REAL_BROWSER:-false}"
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
  SCREEN_COMMAND="cd $(shell_escape "$SCRIPT_DIR"); export PATH=$(shell_escape "$PATH"); export NODE_BIN=$(shell_escape "$NODE_BIN"); $(shell_escape "$NODE_BIN") server.js; echo 'Server stopped. Press any key to exit screen.'; read -n 1"

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
