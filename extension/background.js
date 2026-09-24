chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "foreteller-api") return false;
  void requestPanel(message).then(sendResponse);
  return true;
});

async function requestPanel(message) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 34_000);
  try {
    const method = message.method;
    if (method !== "GET" && method !== "PUT" && method !== "DELETE") {
      return { ok: false, error: "Unsupported request" };
    }
    const port = Number(message.port);
    if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
      return { ok: false, error: "Invalid panel service port" };
    }
    const response = await fetch(`http://127.0.0.1:${String(port)}/v1/panel`, {
      method,
      signal: controller.signal,
      headers: method === "PUT" ? { "Content-Type": "application/json" } : undefined,
      body: method === "PUT" ? JSON.stringify(message.body) : undefined,
    });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) {
      return { ok: false, error: body?.error ?? `Panel service returned ${response.status}` };
    }
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError"
        ? "Panel service timed out"
        : "Foreteller panel service is unavailable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "foreteller-stream") return;
  let socket;
  let reconnectTimer;
  let timeout;
  let stopped = false;
  let attempts = 0;
  let servicePort;

  function connect() {
    if (stopped) return;
    socket = new WebSocket(`ws://127.0.0.1:${servicePort}/v1/panel/stream`);
    const current = socket;
    timeout = setTimeout(() => current.close(), 10_000);
    current.onopen = () => clearTimeout(timeout);
    current.onmessage = (event) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => current.close(), 45_000);
      const snapshot = JSON.parse(event.data);
      if (snapshot.type !== "heartbeat") port.postMessage({ ok: true, body: snapshot });
    };
    current.onclose = () => {
      clearTimeout(timeout);
      if (stopped) return;
      port.postMessage({ ok: false, error: attempts < 5
        ? "Live updates disconnected. Reconnecting…"
        : "Live updates disconnected. Reload this page to reconnect." });
      if (attempts < 5) reconnectTimer = setTimeout(connect, Math.min(1_000 * 2 ** attempts++, 10_000));
    };
  }

  port.onMessage.addListener((message) => {
    if (servicePort !== undefined) return;
    const requestedPort = Number(message.port);
    if (!Number.isInteger(requestedPort) || requestedPort < 1_024 || requestedPort > 65_535) {
      port.postMessage({ ok: false, error: "Invalid panel service port" });
      return;
    }
    servicePort = requestedPort;
    connect();
  });
  port.onDisconnect.addListener(() => {
    stopped = true;
    clearTimeout(reconnectTimer);
    clearTimeout(timeout);
    socket?.close();
  });
});
