const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function commandExists(command) {
  try {
    execSync(`command -v "${command}"`, { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

function isAbsoluteLike(target) {
  return path.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target);
}

function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getChromeCandidates() {
  const cwd = process.cwd();
  const envChromeBin = process.env.CHROME_BIN;

  if (process.platform === 'darwin') {
    return unique([
      envChromeBin,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(cwd, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(cwd, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      'google-chrome',
      'Google Chrome',
      'chromium',
    ]);
  }

  if (process.platform === 'win32') {
    return unique([
      envChromeBin,
      'chrome.exe',
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }

  return unique([
    envChromeBin,
    path.join(cwd, 'chrome-linux64', 'chrome'),
    path.join(cwd, 'chrome-linux', 'chrome'),
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'google-chrome-stable',
    'google-chrome',
    'chromium',
    'chromium-browser',
  ]);
}

function resolveChromeBinary(configuredValue) {
  const candidates = unique([configuredValue, ...getChromeCandidates()]);

  for (const candidate of candidates) {
    if (!candidate) continue;

    if (isAbsoluteLike(candidate)) {
      if (isExecutable(candidate) || fs.existsSync(candidate)) {
        return {
          value: candidate,
          source: candidate === configuredValue ? 'configured_path' : 'fallback_path',
        };
      }
      continue;
    }

    if (commandExists(candidate)) {
      return {
        value: candidate,
        source: candidate === configuredValue ? 'configured_command' : 'fallback_command',
      };
    }
  }

  return null;
}

module.exports = {
  commandExists,
  resolveChromeBinary,
};
