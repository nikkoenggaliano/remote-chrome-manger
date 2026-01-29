# Chrome Fleet Control

A web interface to control multiple Chrome browsers remotely using Chrome DevTools Protocol (CDP).

## Features
- Create local Chrome instances with unique profiles.
- Support for Xvfb (headless display) and Socat (port forwarding).
- Connect and control external Chrome resources.
- Real-time status updates via Socket.io.
- Tab management (new, close, navigate).
- Live screenshots/thumbnails of tabs.
- SQLite3 database for persistence.

## Prerequisites
- Node.js (Latest)
- Google Chrome or Chromium
- `socat` (Optional, for port forwarding) [but better install]
- `Xvfb` (Optional, for Linux headless display) [but better install]

### Install Prerequisites

Before starting, make sure you have the following dependencies installed on your system:

#### 1. **Node.js (Latest)**
   - For most systems, you can install Node.js using the following commands:
     - **macOS & Linux** minimum 22 can be 24 or even latest: 

       ```bash
       curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
       sudo apt-get install -y nodejs
       ```
     - **Windows**: 
       Download the latest Node.js version from the [official Node.js website](https://nodejs.org/) and follow the installer steps.

#### 2. **Google Chrome or Chromium**
   - **macOS**:
     - Install via Homebrew:
       ```bash
       brew install --cask google-chrome
       ```
   - **Linux (Ubuntu)**:
     - To install Google Chrome:
       ```bash
       sudo apt update
       sudo apt install google-chrome-stable
       ```
     - To install Chromium:
       ```bash
       sudo apt update
       sudo apt install chromium-browser
       ```
   - **Windows**:
     Download and install from [Google Chrome's official website](https://www.google.com/chrome/), or use the [Chromium download page](https://www.chromium.org/getting-involved/download-chromium).
     
#### **Google Chrome or Chromium**

If you'd prefer to download the `.deb` package and install Google Chrome manually, follow these steps:

- **Download the .deb file**:
    - Go to the [Google Chrome download page](https://www.google.com/chrome/) and download the `.deb` file for Debian/Ubuntu-based systems.

- **Install the .deb package**:
    After downloading, open a terminal and run the following commands:
    ```bash
    sudo dpkg -i ~/Downloads/google-chrome-stable_current_amd64.deb
    sudo apt --fix-broken install
    ```
    This will install Google Chrome and fix any missing dependencies.

- **Alternatively**, if you want to install Chromium instead, follow the same steps but download the `.deb` package from the [Chromium download page](https://www.chromium.org/getting-involved/download-chromium).

This method avoids using the `apt` package manager and gives you the latest `.deb` package directly from Google's website.


#### 3. **`socat` (Optional, for port forwarding)**
   - **macOS & Linux**:
     - Install using Homebrew (macOS) or `apt-get` (Linux):
       ```bash
       brew install socat
       ```
       or
       ```bash
       sudo apt install socat
       ```
   - **Windows**: 
     Download the `socat` Windows binary from [here](http://www.dest-unreach.org/socat/).

#### 4. **`Xvfb` (Optional, for Linux headless display)**
   - **Linux (Ubuntu)**:
     Install `Xvfb` with:
     ```bash
     sudo apt update
     sudo apt install xvfb
     ```
   - **macOS & Windows**: This step is typically not required for macOS and Windows systems as they support GUI natively.

Once you've installed these prerequisites, you're ready to proceed with setting up your environment!


## Installing

```bash
npm install
```

## Running 
```bash
./run.sh USERNAME=admin PASSWORD=admin 
```

or auto in `screen` 

```bash
./run.sh USERNAME=admin PASSWORD=admin RUN_IN_SCREEN=true
``` 

Then open `http://localhost:3000` in your browser.


## macOS Notes
On macOS, Google Chrome is expected at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. You can override this with the `CHROME_BIN` environment variable.


```bash
export CHROME_BIN="/path/to/chrome"
node server.js
```

Or even just normally running and change it on configuration menu!