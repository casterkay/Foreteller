const PANEL_API = "http://127.0.0.1:4318/v1/panel";

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
    const response = await fetch(PANEL_API, {
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
