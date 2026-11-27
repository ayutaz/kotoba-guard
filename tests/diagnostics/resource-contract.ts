import path from "node:path";

const runtime = "0f99811fb1a78a0a40c86ada6bda1fa5a42b10f7";

export function parseResourceTrialEnvironment(
  environment: Record<string, string | undefined>,
) {
  const sourceCommit = environment.SOURCE_COMMIT;
  const runtimeSourceCommit = environment.RUNTIME_SOURCE_COMMIT;
  const output = environment.KOTOBA_RESOURCE_OUTPUT;
  const preflightSha256 = environment.KOTOBA_RESOURCE_PREFLIGHT_SHA256;
  if (
    !sourceCommit ||
    !/^[0-9a-f]{40}$/.test(sourceCommit) ||
    runtimeSourceCommit !== runtime ||
    !output ||
    !path.isAbsolute(output) ||
    !preflightSha256 ||
    !/^[0-9a-f]{64}$/.test(preflightSha256)
  ) {
    throw new Error("invalid-resource-trial");
  }
  return { sourceCommit, runtimeSourceCommit, output, preflightSha256 };
}

/** Formal acceptance additionally verifies the pinned baseline and all actual files.
 * This binds the standalone report to that mandatory external preflight receipt.
 */
export function validateResourcePreflight(
  value: unknown,
  trial: ReturnType<typeof parseResourceTrialEnvironment>,
  actualSha256: string,
): void {
  if (!value || typeof value !== "object")
    throw new Error("invalid-resource-preflight");
  const candidate = value as Record<string, unknown>;
  const assets = candidate.assets;
  if (
    actualSha256 !== trial.preflightSha256 ||
    candidate.source_commit !== trial.sourceCommit ||
    candidate.runtime_source_commit !== trial.runtimeSourceCommit ||
    candidate.source_clean !== true ||
    candidate.reused_runtime_assets !== true ||
    !assets ||
    typeof assets !== "object" ||
    Array.isArray(assets) ||
    Object.keys(assets).length !== 81 ||
    Object.values(assets).some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return true;
      const item = entry as { bytes?: unknown; sha256?: unknown };
      return (
        typeof item.bytes !== "number" ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes <= 0 ||
        typeof item.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(item.sha256)
      );
    })
  )
    throw new Error("invalid-resource-preflight");
}

/** Restrict only the owned diagnostic CDP connection. Playwright still uses CDP. */
export function createResourceCdp(
  send: (
    method: string,
    parameters?: Record<string, unknown>,
  ) => Promise<unknown>,
) {
  const commands: string[] = [];
  return {
    commands,
    async send(
      method: string,
      parameters?: Record<string, unknown>,
    ): Promise<unknown> {
      if (
        !(method === "SystemInfo.getProcessInfo" && parameters === undefined) &&
        !(
          method === "Target.setDiscoverTargets" &&
          parameters?.discover === true &&
          Object.keys(parameters).length === 1
        )
      ) {
        throw new Error("forbidden-resource-cdp");
      }
      commands.push(method);
      return send(method, parameters);
    },
  };
}

export function isSuccessfulRelease(
  value: unknown,
  expectedCount: number,
): boolean {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { ready?: unknown; releases?: unknown };
  if (
    candidate.ready !== false ||
    !candidate.releases ||
    typeof candidate.releases !== "object"
  )
    return false;
  const counts = candidate.releases as Record<string, unknown>;
  return (
    counts.completed === expectedCount &&
    counts.failed === 0 &&
    counts.timedOut === 0 &&
    counts.sendFailed === 0
  );
}
