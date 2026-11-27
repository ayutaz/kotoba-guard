/** Diagnostic only. Never bundled into the production extension.
 * @param {{WebAssembly: typeof WebAssembly, WeakRef: typeof WeakRef}} scope
 * @param {number} limit
 */
export function installWasmMemoryProbe(scope = globalThis, limit = 32) {
  if (Object.hasOwn(scope, "__kotobaMemoryProbeSnapshot"))
    throw new Error("memory-probe-already-installed");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
    throw new Error("invalid-memory-probe-limit");
  const api = scope.WebAssembly;
  const NativeMemory = api.Memory;
  const NativeInstance = api.Instance;
  const seen = new WeakSet();
  const references = [];
  let incomplete = false;

  const trackMemory = (value) => {
    if (!(value instanceof NativeMemory) || seen.has(value)) return;
    seen.add(value);
    if (references.length >= limit) {
      incomplete = true;
      return;
    }
    references.push(new scope.WeakRef(value));
  };
  const trackInstance = (value) => {
    try {
      const instance =
        value instanceof NativeInstance ? value : value?.instance;
      if (instance instanceof NativeInstance)
        for (const exported of Object.values(instance.exports))
          trackMemory(exported);
    } catch {
      incomplete = true;
    }
  };
  const snapshot = () => {
    const byteLengths = [];
    for (const reference of references) {
      const memory = reference.deref();
      if (memory) byteLengths.push(memory.buffer.byteLength);
    }
    return {
      status: incomplete ? "incomplete" : "complete",
      observedCount: references.length,
      liveCount: byteLengths.length,
      totalBytes: byteLengths.reduce((a, b) => a + b, 0),
      byteLengths: byteLengths.sort((a, b) => a - b),
    };
  };
  api.Memory = new Proxy(NativeMemory, {
    construct(target, argumentsList, newTarget) {
      const memory = Reflect.construct(target, argumentsList, newTarget);
      try {
        trackMemory(memory);
      } catch {
        incomplete = true;
      }
      return memory;
    },
  });
  api.Instance = new Proxy(NativeInstance, {
    construct(target, argumentsList, newTarget) {
      const instance = Reflect.construct(target, argumentsList, newTarget);
      trackInstance(instance);
      return instance;
    },
  });
  for (const method of ["instantiate", "instantiateStreaming"]) {
    if (typeof api[method] !== "function") continue;
    api[method] = new Proxy(api[method], {
      apply(target, thisArgument, argumentsList) {
        const promise = Reflect.apply(target, thisArgument, argumentsList);
        void promise.then(trackInstance, () => undefined);
        return promise;
      },
    });
  }
  Object.defineProperty(scope, "__kotobaMemoryProbeSnapshot", {
    value: snapshot,
    configurable: false,
    writable: false,
  });
  return { snapshot };
}

if (
  typeof globalThis.WorkerGlobalScope !== "undefined" &&
  globalThis instanceof globalThis.WorkerGlobalScope
)
  installWasmMemoryProbe();
