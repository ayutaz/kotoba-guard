import path from "node:path";

type Target = {
  targetId: string;
  type: string;
  url: string;
  parentId?: string;
};

export function findProbeParents(
  targets: readonly Target[],
  extensionId: string,
): Target[] {
  if (!/^[a-p]{32}$/.test(extensionId))
    throw new Error("Invalid fixture owner");
  return targets.filter(
    (target) =>
      target.url === `chrome-extension://${extensionId}/offscreen.html` &&
      ["page", "other", "background_page"].includes(target.type),
  );
}
const knownTypes = new Set([
  "page",
  "tab",
  "other",
  "background_page",
  "service_worker",
  "worker",
  "iframe",
  "shared_worker",
  "browser",
  "webview",
]);

type ProbeTarget = {
  readonly role:
    "offscreen" | "worker" | "extension-other" | "foreign" | "empty-url";
  readonly type: string;
  readonly hasParent: boolean;
  readonly targetId?: string;
  readonly exactLocation?: boolean;
};

export async function visibilityDeadline<T>(
  action: () => Promise<T>,
  timeoutMs = 5_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Visibility operation timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function classifyProbeTargets(
  targets: readonly Target[],
  extensionId: string,
): ProbeTarget[] {
  if (!/^[a-p]{32}$/.test(extensionId))
    throw new Error("Invalid fixture owner");
  return targets.map((target) => {
    const type = knownTypes.has(target.type) ? target.type : "unknown";
    const common = {
      type,
      hasParent:
        typeof target.parentId === "string" && target.parentId.length > 0,
    };
    if (!target.url) return { role: "empty-url", ...common };
    let url: URL;
    try {
      url = new URL(target.url);
    } catch {
      return { role: "foreign", ...common };
    }
    if (url.protocol !== "chrome-extension:" || url.host !== extensionId)
      return { role: "foreign", ...common };
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(target.targetId))
      throw new Error("Invalid owned target ID");
    const role =
      url.pathname === "/offscreen.html"
        ? "offscreen"
        : url.pathname === "/worker.js"
          ? "worker"
          : "extension-other";
    return {
      role,
      ...common,
      targetId: target.targetId,
      exactLocation:
        (role === "offscreen" || role === "worker") &&
        target.url === `chrome-extension://${extensionId}${url.pathname}`,
    };
  });
}

export function readVisibilityEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const sourceCommit = environment.SOURCE_COMMIT;
  const executablePath = environment.KOTOBA_GUARD_BROWSER_EXECUTABLE;
  const output = environment.KOTOBA_VISIBILITY_OUTPUT;
  if (
    !/^[a-f0-9]{40}$/.test(sourceCommit ?? "") ||
    !executablePath ||
    !path.isAbsolute(executablePath) ||
    !output ||
    !path.isAbsolute(output) ||
    output !==
      path.resolve(
        "artifacts/chrome116-worker-visibility",
        sourceCommit!,
        "report.json",
      )
  )
    throw new Error("Invalid visibility trial environment");
  return { sourceCommit: sourceCommit!, executablePath, output };
}

export function visibilityFixtureFiles(): Record<string, string> {
  return {
    "manifest.json": JSON.stringify({
      manifest_version: 3,
      name: "Kotoba Worker visibility fixture",
      version: "0.0.0",
      permissions: ["offscreen"],
      background: { service_worker: "background.js" },
      content_security_policy: {
        extension_pages:
          "script-src 'self'; object-src 'self'; connect-src 'self'; worker-src 'self'",
      },
    }),
    "background.js": `let ready=false;chrome.runtime.onMessage.addListener((m,s,r)=>{if(s.id!==chrome.runtime.id)return false;if(m.type==="start"){chrome.offscreen.createDocument({url:"offscreen.html",reasons:["WORKERS"],justification:"Model-free Worker visibility diagnosis"}).then(()=>r({ok:true}),()=>r({ok:false}));return true;}if(m.type==="fixture-ready"){ready=true;return false;}if(m.type==="state"){r({ready});return false;}if(m.type==="stop"){chrome.offscreen.closeDocument().then(()=>r({ok:true}),()=>r({ok:false}));return true;}return false;});`,
    "popup.html":
      "<!doctype html><meta charset=utf-8><title>Local visibility fixture</title>",
    "offscreen.html":
      '<!doctype html><script type="module" src="offscreen.js"></script>',
    "offscreen.js": `const worker=new Worker(chrome.runtime.getURL("worker.js"),{type:"module"});worker.onmessage=e=>{if(e.data==="fixture-pong")void chrome.runtime.sendMessage({type:"fixture-ready"});};worker.postMessage("fixture-ping");`,
    "worker.js": `self.onmessage=e=>{if(e.data==="fixture-ping")postMessage("fixture-pong");};`,
  };
}
