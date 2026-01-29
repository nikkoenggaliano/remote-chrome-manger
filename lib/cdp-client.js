const CDP = require('chrome-remote-interface');
const fetch = require('node-fetch');

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

module.exports = {
  getTabs,
  newTab,
  closeTab,
  captureScreenshot,
  navigateTab,
  sendInput,
};