/** Explicit report bindings; the outer trial still verifies Git and all assets. */
export function readSourceIdentity(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { readonly sourceCommit: string; readonly runtimeSourceCommit: string } {
  const source = environment.SOURCE_COMMIT;
  const runtime = environment.RUNTIME_SOURCE_COMMIT;
  const commit = /^[0-9a-f]{40}$/;
  if (
    (source !== undefined && !commit.test(source)) ||
    (runtime !== undefined && (!commit.test(runtime) || source === undefined))
  )
    throw new Error("Invalid browser evidence source identity");
  return {
    sourceCommit: source ?? "working-tree",
    runtimeSourceCommit: runtime ?? source ?? "working-tree",
  };
}
