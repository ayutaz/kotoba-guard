import { describe, expect, it } from "vitest";
import { isAcceptedOffscreenSender } from "../shared/security";

describe("offscreen message boundary", () => {
  const id = "abcdefghijklmnopabcdefghijklmnop";

  it("accepts the service worker sender with no URL and rejects web/external senders", () => {
    expect(isAcceptedOffscreenSender({ id }, id)).toBe(true);
    expect(
      isAcceptedOffscreenSender(
        { id, url: `chrome-extension://${id}/background.js` },
        id,
      ),
    ).toBe(true);
    expect(
      isAcceptedOffscreenSender({ id, url: "https://example.test/" }, id),
    ).toBe(false);
    expect(isAcceptedOffscreenSender({}, id)).toBe(false);
  });

  it("rejects extension pages and tab senders even when their extension ID matches", () => {
    for (const name of [
      "popup.html",
      "options.html",
      "offscreen.html",
      "other.js",
      "background.js?fake",
    ])
      expect(
        isAcceptedOffscreenSender(
          { id, url: `chrome-extension://${id}/${name}` },
          id,
        ),
      ).toBe(false);
    expect(
      isAcceptedOffscreenSender({ id, tab: { id: 1 } as chrome.tabs.Tab }, id),
    ).toBe(false);
  });
});
