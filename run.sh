#!/bin/bash

# Defaults
NIKKO_CHROME_USERNAME=""
NIKKO_CHROME_PASSWORD=""
RUN_IN_SCREEN="false"
SESSION_NAME="chrome-fleet"

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper: Parse arguments (format KEY=VALUE)
for ARGUMENT in "$@"
do
   KEY=$(echo $ARGUMENT | cut -f1 -d=)
   KEY_LENGTH=${#KEY}
   VALUE="${ARGUMENT:$KEY_LENGTH+1}"

   export "$KEY"="$VALUE"
done

# Default Port if not set
if [ -z "$PORT" ]; then
    PORT=3000
fi

# Check Auth
if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
    echo -e "${RED}Error: USERNAME and PASSWORD are required.${NC}"
    echo "Usage: ./run.sh USERNAME=admin PASSWORD=secret [PORT=3000] [RUN_IN_SCREEN=true]"
    exit 1
fi

export NIKKO_CHROME_USERNAME="$USERNAME"
export NIKKO_CHROME_PASSWORD="$PASSWORD"
export PORT="$PORT"

echo -e "${GREEN}>>> Chrome Fleet Control Launcher <<<${NC}"
echo "User: $NIKKO_CHROME_USERNAME"
echo "Port: $PORT"

# --- Dependency Check ---
MISSING_DEPS=0
OS_TYPE=""

if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_TYPE=$ID
elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS_TYPE="macos"
fi

check_cmd() {
    if ! command -v "$1" &> /dev/null; then
        echo -e "${YELLOW}Missing dependency: $1${NC}"
        return 1
    else
        echo -e "${GREEN}Found: $1${NC}"
        return 0
    fi
}

echo "Checking dependencies..."

# Check Node.js
if ! check_cmd "node"; then
    echo -e "${RED}Critical: Node.js is not installed.${NC}"
    MISSING_DEPS=1
fi

# Check Chrome
if [[ "$OS_TYPE" == "macos" ]]; then
    if [ ! -d "/Applications/Google Chrome.app" ]; then
         echo -e "${YELLOW}Warning: Google Chrome.app not found in /Applications.${NC}"
    else
         echo -e "${GREEN}Found: Google Chrome.app${NC}"
    fi
else
    if ! check_cmd "google-chrome" && ! check_cmd "chromium" && ! check_cmd "chromium-browser"; then
        echo -e "${YELLOW}Missing: google-chrome or chromium${NC}"
        MISSING_DEPS=1
    fi
fi

# Check Socat & Xvfb (Optional but recommended)
check_cmd "socat" || MISSING_DEPS=1
if [[ "$OS_TYPE" != "macos" ]]; then
    check_cmd "Xvfb" || MISSING_DEPS=1
fi

# Suggest Install Commands
if [ $MISSING_DEPS -eq 1 ]; then
    echo ""
    echo -e "${RED}Some dependencies are missing. Please install them:${NC}"
    
    if [[ "$OS_TYPE" == "ubuntu" ]] || [[ "$OS_TYPE" == "debian" ]] || [[ "$OS_TYPE" == "linuxmint" ]]; then
        echo "  sudo apt update"
        echo "  sudo apt install -y google-chrome-stable socat xvfb screen"
        echo "  (Note: For Node.js, see https://github.com/nodesource/distributions)"
    elif [[ "$OS_TYPE" == "centos" ]] || [[ "$OS_TYPE" == "rhel" ]] || [[ "$OS_TYPE" == "fedora" ]]; then
        echo "  sudo yum install -y google-chrome-stable socat xorg-x11-server-Xvfb screen"
    elif [[ "$OS_TYPE" == "macos" ]]; then
        echo "  brew install socat"
        echo "  (Chrome should be installed via DMG)"
    else
        echo "  Please install: google-chrome, socat, xvfb, screen"
    fi
    
    echo ""
    read -p "Continue anyway? (y/N) " confirm
    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
        exit 1
    fi
fi

# --- Execution ---

# Install NPM deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing node dependencies..."
    npm install
fi

if [ "$RUN_IN_SCREEN" == "true" ]; then
    if ! check_cmd "screen"; then
        echo -e "${RED}Error: 'screen' is required for RUN_IN_SCREEN=true.${NC}"
        exit 1
    fi

    # Check if already running - more robust check
    if screen -ls | grep -q "\.${SESSION_NAME}[[:space:]]"; then
        echo -e "${YELLOW}Session '$SESSION_NAME' is already running.${NC}"
        echo "Attach with: screen -r $SESSION_NAME"
    else
        echo "Starting server in screen session '$SESSION_NAME'..."
        # We pass env vars explicitly and ensure PATH is preserved
        # On macOS, we use 'bash -l' to ensure login profile is loaded if needed, 
        # but here we just want to make sure node is found.
        CURRENT_PATH="$PATH"
        screen -dmS "$SESSION_NAME" bash -c "export PATH='$CURRENT_PATH'; export NIKKO_CHROME_USERNAME='$USERNAME'; export NIKKO_CHROME_PASSWORD='$PASSWORD'; export PORT='$PORT'; node server.js; echo 'Server stopped. Press any key to exit screen.'; read -n 1"
        
        # Give it a second to start
        sleep 1
        if screen -ls | grep -q "\.${SESSION_NAME}[[:space:]]"; then
            echo -e "${GREEN}Server started in background!${NC}"
            echo "Attach command: screen -r $SESSION_NAME"
        else
            echo -e "${RED}Failed to start screen session. Try running without RUN_IN_SCREEN=true to see errors.${NC}"
        fi
    fi
else
    echo "Starting server in foreground..."
    node server.js
fi
