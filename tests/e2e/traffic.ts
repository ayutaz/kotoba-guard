import type { BrowserContext, Request } from "@playwright/test";

export type TrafficRecord = {
  url: string;
  resourceType: string;
  initiator: string;
};

/** The fixture has no scripts or remote assets. Only its top-level navigation
 * is allowed; an extension fetch to the same loopback origin is still a failure.
 * Context request events include service-worker HTTP requests in Chromium.
 */
export function watchTraffic(context: BrowserContext, origin: string) {
  const unexpected: TrafficRecord[] = [];
  const navigation: TrafficRecord[] = [];
  const record = (request: Request): void => {
    const url = request.url();
    if (!/^(https?|wss?):/.test(url)) return;
    let initiator = request.serviceWorker()?.url() ?? "unknown-worker";
    let topLevel = false;
    if (!request.serviceWorker()) {
      try {
        const frame = request.frame();
        initiator = frame.url();
        topLevel = frame.parentFrame() === null;
      } catch {
        // Dedicated-worker requests may have no frame. Retain that evidence.
      }
    }
    const entry = { url, resourceType: request.resourceType(), initiator };
    if (url === `${origin}/` && request.isNavigationRequest() && topLevel)
      navigation.push(entry);
    else unexpected.push(entry);
  };
  context.on("request", record);
  context.on("page", (page) => {
    page.on("websocket", (socket) =>
      unexpected.push({
        url: socket.url(),
        resourceType: "websocket",
        initiator: page.url(),
      }),
    );
  });
  return { unexpected, navigation };
}
