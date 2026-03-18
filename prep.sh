#!/bin/bash

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

AUTO_INSTALL="false"
RUN_NPM_INSTALL="true"
REQUIRE_SCREEN="false"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

for ARGUMENT in "$@"; do
  KEY=$(echo "$ARGUMENT" | cut -f1 -d=)
  KEY_LENGTH=${#KEY}
  VALUE="${ARGUMENT:$KEY_LENGTH+1}"
  export "$KEY"="$VALUE"
done

normalize_bool() {
  case "${1:-false}" in
    1|true|TRUE|True|yes|YES|on|ON) echo "true" ;;
    *) echo "false" ;;
  esac
}

AUTO_INSTALL=$(normalize_bool "${AUTO_INSTALL:-false}")
RUN_NPM_INSTALL=$(normalize_bool "${RUN_NPM_INSTALL:-true}")
REQUIRE_SCREEN=$(normalize_bool "${REQUIRE_SCREEN:-false}")

OS_FAMILY="unknown"
DISTRO_ID=""
DISTRO_LIKE=""
PKG_MANAGER=""
ARCH="$(uname -m 2>/dev/null || echo unknown)"
CHROME_DETECTED=""
NODE_BIN_DETECTED=""
NPM_BIN_DETECTED=""
NPM_CLI_DETECTED=""
NPM_SPEC_DETECTED=""
ERROR_COUNT=0

log_info() {
  echo -e "${BLUE}INFO${NC} $1"
}

log_ok() {
  echo -e "${GREEN}OK${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}WARN${NC} $1"
}

log_error() {
  echo -e "${RED}ERR${NC} $1"
  ERROR_COUNT=$((ERROR_COUNT + 1))
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
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

  if command_exists "$candidate"; then
    command -v "$candidate"
    return 0
  fi

  return 1
}

find_working_node_bin() {
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

find_working_npm_spec() {
  local candidate
  local resolved
  for candidate in "${NPM_BIN:-}" npm /opt/homebrew/opt/node@22/bin/npm /usr/local/bin/npm /usr/bin/npm; do
    if resolved="$(resolve_binary "$candidate")" && "$resolved" --version >/dev/null 2>&1; then
      echo "binary:$resolved"
      return 0
    fi
  done

  for candidate in "${NPM_CLI:-}" /opt/homebrew/opt/node@22/lib/node_modules/npm/bin/npm-cli.js /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/lib/node_modules/npm/bin/npm-cli.js; do
    if [ -n "${NODE_BIN_DETECTED:-}" ] && [ -f "$candidate" ] && "$NODE_BIN_DETECTED" "$candidate" --version >/dev/null 2>&1; then
      echo "cli:$candidate"
      return 0
    fi
  done
  return 1
}

apply_npm_spec() {
  case "$1" in
    binary:*)
      NPM_BIN_DETECTED="${1#binary:}"
      NPM_CLI_DETECTED=""
      ;;
    cli:*)
      NPM_BIN_DETECTED="$NODE_BIN_DETECTED"
      NPM_CLI_DETECTED="${1#cli:}"
      ;;
  esac
}

run_npm() {
  if [ -n "$NPM_CLI_DETECTED" ]; then
    "$NODE_BIN_DETECTED" "$NPM_CLI_DETECTED" "$@"
  else
    "$NPM_BIN_DETECTED" "$@"
  fi
}

detect_os() {
  case "$OSTYPE" in
    darwin*) OS_FAMILY="macos" ;;
    linux*)
      OS_FAMILY="linux"
      if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO_ID="${ID:-}"
        DISTRO_LIKE="${ID_LIKE:-}"
      fi
      ;;
    msys*|cygwin*|win32*)
      OS_FAMILY="windows"
      ;;
  esac

  if command_exists brew; then
    PKG_MANAGER="brew"
  elif command_exists apt-get; then
    PKG_MANAGER="apt-get"
  elif command_exists dnf; then
    PKG_MANAGER="dnf"
  elif command_exists yum; then
    PKG_MANAGER="yum"
  elif command_exists pacman; then
    PKG_MANAGER="pacman"
  elif command_exists zypper; then
    PKG_MANAGER="zypper"
  elif command_exists winget; then
    PKG_MANAGER="winget"
  elif command_exists choco; then
    PKG_MANAGER="choco"
  else
    PKG_MANAGER=""
  fi
}

find_chrome() {
  if [ -n "${CHROME_BIN:-}" ] && [ -x "${CHROME_BIN:-}" ]; then
    echo "$CHROME_BIN"
    return 0
  fi

  case "$OS_FAMILY" in
    macos)
      if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
        echo "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        return 0
      fi
      if [ -x "/Applications/Chromium.app/Contents/MacOS/Chromium" ]; then
        echo "/Applications/Chromium.app/Contents/MacOS/Chromium"
        return 0
      fi
      ;;
    linux)
      for candidate in "$SCRIPT_DIR/chrome-linux64/chrome" "$SCRIPT_DIR/chrome-linux/chrome"; do
        if [ -x "$candidate" ]; then
          echo "$candidate"
          return 0
        fi
      done
      ;;
    windows)
      for candidate in \
        "/c/Program Files/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \
        "${LOCALAPPDATA:-}/Google/Chrome/Application/chrome.exe"; do
        if [ -x "$candidate" ]; then
          echo "$candidate"
          return 0
        fi
      done
      ;;
  esac

  for candidate in google-chrome-stable google-chrome chromium chromium-browser chrome.exe; do
    if command_exists "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

install_node_runtime() {
  case "$PKG_MANAGER" in
    brew)
      brew install node
      ;;
    apt-get)
      sudo apt-get update
      sudo apt-get install -y nodejs npm
      ;;
    dnf)
      sudo dnf install -y nodejs npm
      ;;
    yum)
      sudo yum install -y nodejs npm
      ;;
    pacman)
      sudo pacman -Sy --noconfirm nodejs npm
      ;;
    zypper)
      sudo zypper --non-interactive install nodejs npm
      ;;
    winget)
      winget install -e --id OpenJS.NodeJS.LTS
      ;;
    choco)
      choco install -y nodejs-lts
      ;;
    *)
      return 1
      ;;
  esac
}

ensure_node_runtime() {
  if NODE_BIN_DETECTED="$(find_working_node_bin)" && NPM_SPEC_DETECTED="$(find_working_npm_spec)"; then
    apply_npm_spec "$NPM_SPEC_DETECTED"
    log_ok "Found node at ${NODE_BIN_DETECTED}"
    if [ -n "$NPM_CLI_DETECTED" ]; then
      log_ok "Found npm CLI at ${NPM_CLI_DETECTED}"
    else
      log_ok "Found npm at ${NPM_BIN_DETECTED}"
    fi
    return 0
  fi

  if [ "$AUTO_INSTALL" = "true" ]; then
    log_info "Attempting to install Node.js runtime..."
    if install_node_runtime; then
      if NODE_BIN_DETECTED="$(find_working_node_bin)" && NPM_SPEC_DETECTED="$(find_working_npm_spec)"; then
        apply_npm_spec "$NPM_SPEC_DETECTED"
        log_ok "Installed node at ${NODE_BIN_DETECTED}"
        if [ -n "$NPM_CLI_DETECTED" ]; then
          log_ok "Installed npm CLI at ${NPM_CLI_DETECTED}"
        else
          log_ok "Installed npm at ${NPM_BIN_DETECTED}"
        fi
        return 0
      fi
    fi
  fi

  if ! find_working_node_bin >/dev/null 2>&1; then
    log_error "Missing node"
  fi
  if ! find_working_npm_spec >/dev/null 2>&1; then
    log_error "Missing npm"
  fi
  return 1
}

install_packages() {
  case "$PKG_MANAGER" in
    brew)
      brew install "$@"
      ;;
    apt-get)
      sudo apt-get update
      sudo apt-get install -y "$@"
      ;;
    dnf)
      sudo dnf install -y "$@"
      ;;
    yum)
      sudo yum install -y "$@"
      ;;
    pacman)
      sudo pacman -Sy --noconfirm "$@"
      ;;
    zypper)
      sudo zypper --non-interactive install "$@"
      ;;
    *)
      return 1
      ;;
  esac
}

install_chrome() {
  case "$OS_FAMILY:$PKG_MANAGER" in
    linux:apt-get)
      if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; then
        log_warn "Official Google Chrome .deb auto-install only supports x86_64/amd64."
        return 1
      fi
      local tmp_deb
      tmp_deb="$(mktemp /tmp/google-chrome-stable.XXXXXX.deb)"
      if command_exists wget; then
        wget -O "$tmp_deb" "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
      elif command_exists curl; then
        curl -fsSL -o "$tmp_deb" "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
      else
        log_error "Neither wget nor curl is available to download Google Chrome."
        return 1
      fi
      sudo apt-get install -y "$tmp_deb"
      rm -f "$tmp_deb"
      ;;
    linux:dnf|linux:yum)
      if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "amd64" ]; then
        log_warn "Official Google Chrome .rpm auto-install only supports x86_64/amd64."
        return 1
      fi
      sudo "$PKG_MANAGER" install -y "https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm"
      ;;
    macos:brew)
      brew install --cask google-chrome
      ;;
    windows:winget)
      winget install -e --id Google.Chrome
      ;;
    windows:choco)
      choco install -y googlechrome
      ;;
    *)
      log_warn "Automatic Chrome install is not supported for OS=$OS_FAMILY package_manager=${PKG_MANAGER:-none}."
      return 1
      ;;
  esac

  return 0
}

install_xvfb() {
  case "$PKG_MANAGER" in
    apt-get)
      sudo apt-get update
      sudo apt-get install -y xvfb
      ;;
    dnf)
      sudo dnf install -y xorg-x11-server-Xvfb
      ;;
    yum)
      sudo yum install -y xorg-x11-server-Xvfb
      ;;
    pacman)
      sudo pacman -Sy --noconfirm xorg-server-xvfb
      ;;
    zypper)
      sudo zypper --non-interactive install xorg-x11-server-Xvfb
      ;;
    *)
      return 1
      ;;
  esac
}

ensure_xvfb() {
  if command_exists Xvfb; then
    log_ok "Found Xvfb"
    return 0
  fi

  if [ "$AUTO_INSTALL" = "true" ]; then
    log_info "Attempting to install Xvfb..."
    if install_xvfb && command_exists Xvfb; then
      log_ok "Installed Xvfb"
      return 0
    fi
  fi

  log_error "Missing Xvfb"
  return 1
}

ensure_command() {
  local command_name="$1"
  local install_label="$2"
  local required="$3"

  if command_exists "$command_name"; then
    log_ok "Found ${command_name}"
    return 0
  fi

  if [ "$AUTO_INSTALL" = "true" ]; then
    log_info "Attempting to install ${install_label}..."
    if install_packages "$install_label"; then
      if command_exists "$command_name"; then
        log_ok "Installed ${command_name}"
        return 0
      fi
    fi
  fi

  if [ "$required" = "true" ]; then
    log_error "Missing ${command_name}"
  else
    log_warn "Missing ${command_name}"
  fi
  return 1
}

print_manual_hints() {
  echo
  log_info "Manual install hints:"

  case "$OS_FAMILY:$PKG_MANAGER" in
    linux:apt-get)
      echo "  sudo apt-get update"
      echo "  sudo apt-get install -y nodejs npm socat xvfb screen lsof unzip wget curl"
      echo "  wget -O /tmp/google-chrome-stable_current_amd64.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb"
      echo "  sudo apt-get install -y /tmp/google-chrome-stable_current_amd64.deb"
      ;;
    linux:dnf|linux:yum)
      echo "  sudo $PKG_MANAGER install -y nodejs npm socat xorg-x11-server-Xvfb screen lsof unzip wget curl"
      echo "  sudo $PKG_MANAGER install -y https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm"
      ;;
    macos:brew)
      echo "  brew install node socat screen wget"
      echo "  brew install --cask google-chrome"
      ;;
    windows:winget)
      echo "  winget install -e --id OpenJS.NodeJS.LTS"
      echo "  winget install -e --id Google.Chrome"
      ;;
    windows:choco)
      echo "  choco install -y nodejs-lts googlechrome"
      ;;
    *)
      echo "  Install Node.js, npm, Google Chrome/Chromium, socat, lsof, unzip, and screen (if you use RUN_IN_SCREEN=true)."
      echo "  On Linux also install Xvfb."
      ;;
  esac
}

detect_os

log_info "Preparing Chrome Fleet Control"
log_info "OS=$OS_FAMILY distro=${DISTRO_ID:-n/a} pkg=${PKG_MANAGER:-n/a} arch=$ARCH"

ensure_node_runtime

if [ "$OS_FAMILY" != "windows" ]; then
  ensure_command socat socat true
fi

if [ "$OS_FAMILY" = "linux" ]; then
  ensure_xvfb
fi

if [ "$REQUIRE_SCREEN" = "true" ] && [ "$OS_FAMILY" != "windows" ]; then
  ensure_command screen screen true
fi

if [ "$OS_FAMILY" != "windows" ]; then
  ensure_command lsof lsof true
fi

if [ "$OS_FAMILY" = "linux" ] || [ "$AUTO_INSTALL" = "true" ]; then
  if ! command_exists unzip; then
    if [ "$AUTO_INSTALL" = "true" ]; then
      install_packages unzip >/dev/null 2>&1 || true
    fi
    if command_exists unzip; then
      log_ok "Found unzip"
    else
      log_warn "Missing unzip"
    fi
  else
    log_ok "Found unzip"
  fi

  if command_exists wget; then
    log_ok "Found wget"
  elif command_exists curl; then
    log_ok "Found curl (wget alternative)"
  else
    if [ "$AUTO_INSTALL" = "true" ]; then
      install_packages wget >/dev/null 2>&1 || install_packages curl >/dev/null 2>&1 || true
    fi
    if command_exists wget; then
      log_ok "Found wget"
    elif command_exists curl; then
      log_ok "Found curl (wget alternative)"
    else
      log_warn "Missing wget/curl"
    fi
  fi
fi

if CHROME_DETECTED="$(find_chrome)"; then
  log_ok "Found Chrome/Chromium at ${CHROME_DETECTED}"
else
  if [ "$AUTO_INSTALL" = "true" ]; then
    log_info "Attempting to install Google Chrome..."
    install_chrome || true
  fi

  if CHROME_DETECTED="$(find_chrome)"; then
    log_ok "Found Chrome/Chromium at ${CHROME_DETECTED}"
  else
    log_error "Chrome/Chromium binary not found"
  fi
fi

if [ "$RUN_NPM_INSTALL" = "true" ]; then
  if [ -n "$NPM_BIN_DETECTED" ]; then
    if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
      log_info "node_modules missing. Running npm install..."
      if run_npm install; then
        log_ok "npm install completed"
      else
        log_error "npm install failed"
      fi
    else
      log_ok "node_modules already present"
    fi
  else
    log_error "Cannot run npm install because npm is missing"
  fi
fi

if [ "$ERROR_COUNT" -gt 0 ]; then
  print_manual_hints
  exit 1
fi

echo
log_ok "Environment is ready"
if [ -n "$CHROME_DETECTED" ] && [ -z "${CHROME_BIN:-}" ]; then
  log_info "Detected browser can be used as CHROME_BIN=${CHROME_DETECTED}"
fi
