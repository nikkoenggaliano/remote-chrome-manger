const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');

async function assertDebugEndpointReachable(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/json/version`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    const message = error.type === 'system' || error.code
      ? `CDP endpoint http://${host}:${port} is not reachable: ${error.message}`
      : `CDP endpoint http://${host}:${port} returned an invalid response: ${error.message}`;
    throw new Error(message);
  }
}

async function getTabs(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/json`);
    return await response.json();
  } catch (err) {
    console.error(`Error fetching tabs for ${host}:${port}:`, err.message);
    return [];
  }
}

async function newTab(host, port, url = 'about:blank') {
  try {
    const response = await fetch(`http://${host}:${port}/json/new?${url}`, { method: 'PUT' });
    return await response.json();
  } catch (err) {
    console.error(`Error creating new tab for ${host}:${port}:`, err.message);
    return null;
  }
}

async function closeTab(host, port, id) {
  try {
    const response = await fetch(`http://${host}:${port}/json/close/${id}`, { method: 'GET' });
    return await response.text();
  } catch (err) {
    console.error(`Error closing tab ${id} for ${host}:${port}:`, err.message);
    return null;
  }
}

async function captureScreenshot(host, port, targetId) {
  let client;
  try {
    client = await CDP({ host, port, target: targetId });
    const { Page } = client;
    await Page.enable();
    const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 50 });
    return data;
  } catch (err) {
    console.error(`Error capturing screenshot for ${host}:${port} tab ${targetId}:`, err.message);
    return null;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

async function navigateTab(host, port, targetId, url) {
  let client;
  try {
    client = await CDP({ host, port, target: targetId });
    const { Page } = client;
    await Page.enable();
    await Page.navigate({ url });
  } catch (err) {
    console.error(`Error navigating tab ${targetId} for ${host}:${port} to ${url}:`, err.message);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

async function sendInput(host, port, targetId, method, params) {
    let client;
    try {
        client = await CDP({ host, port, target: targetId });
        await client.send(method, params);
    } catch (err) {
        console.error(`Error sending input to ${host}:${port} tab ${targetId}:`, err.message);
        throw err;
    } finally {
        if (client) {
            await client.close();
        }
    }
}

async function importCookies(host, port, cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { imported: 0, failed: 0, failures: [] };
  }

  let client;
  let temporaryTabId = null;

  try {
    await assertDebugEndpointReachable(host, port);
    const tabs = await getTabs(host, port);
    let target = tabs.find((tab) => tab.type === 'page') || tabs[0] || null;

    if (!target) {
      const createdTab = await newTab(host, port, 'about:blank');
      if (!createdTab?.id) {
        throw new Error('Failed to create a temporary tab for cookie import');
      }
      temporaryTabId = createdTab.id;
      target = createdTab;
    }

    client = await CDP({ host, port, target: target.id });
    const { Network } = client;
    await Network.enable();

    const failures = [];
    let imported = 0;

    for (const cookie of cookies) {
      try {
        const result = await Network.setCookie(cookie);
        if (result && result.success === false) {
          throw new Error('CDP rejected the cookie');
        }
        imported += 1;
      } catch (error) {
        failures.push({
          name: cookie.name,
          domain: cookie.domain || null,
          path: cookie.path || null,
          error: error.message,
        });
      }
    }

    return {
      imported,
      failed: failures.length,
      failures,
    };
  } catch (error) {
    console.error(`Error importing cookies into ${host}:${port}:`, error.message);
    throw error;
  } finally {
    if (client) {
      await client.close();
    }
    if (temporaryTabId) {
      await closeTab(host, port, temporaryTabId);
    }
  }
}

module.exports = {
  getTabs,
  newTab,
  closeTab,
  captureScreenshot,
  navigateTab,
  sendInput,
  importCookies,
  assertDebugEndpointReachable,
};
