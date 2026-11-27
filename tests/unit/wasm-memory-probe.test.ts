import { describe, expect, it } from "vitest";
import { installWasmMemoryProbe } from "../../scripts/diagnostics/wasm-memory-probe.mjs";
import { calibrationMemoryModule } from "../diagnostics/heap-fixture";

const bytes = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 5, 4, 1, 1, 1, 64, 7, 10, 1, 6, 109, 101, 109,
  111, 114, 121, 2, 0,
]);
function scope() {
  return {
    WebAssembly: Object.create(WebAssembly) as typeof WebAssembly,
    WeakRef,
  };
}

describe("WASM numeric memory probe", () => {
  it("uses the declared sixteen MiB fixture memory", () => {
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(calibrationMemoryModule),
    );
    expect(
      (instance.exports.memory as WebAssembly.Memory).buffer.byteLength,
    ).toBe(16 * 1024 * 1024);
  });

  it("preserves the native returned Promise identity", async () => {
    const target = scope();
    const promise = WebAssembly.instantiate(bytes);
    Object.defineProperty(target.WebAssembly, "instantiate", {
      value: () => promise,
      configurable: true,
      writable: true,
    });
    const probe = installWasmMemoryProbe(target);
    expect(target.WebAssembly.instantiate(bytes)).toBe(promise);
    await promise;
    expect(probe.snapshot().totalBytes).toBe(65536);
  });
  it("delegates constructors and reads live size after growth without touching global APIs", () => {
    const target = scope();
    const probe = installWasmMemoryProbe(target);
    const memory = new target.WebAssembly.Memory({ initial: 1, maximum: 4 });
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    expect(probe.snapshot()).toMatchObject({
      status: "complete",
      liveCount: 1,
      totalBytes: 65536,
    });
    memory.grow(1);
    expect(probe.snapshot().byteLengths).toEqual([131072]);
    expect(target.WebAssembly.Memory).not.toBe(WebAssembly.Memory);
    expect(() => installWasmMemoryProbe(target)).toThrow(
      "memory-probe-already-installed",
    );
  });

  it("detects internal exported memories through Instance and both instantiate return forms", async () => {
    const target = scope();
    const probe = installWasmMemoryProbe(target);
    const module = new WebAssembly.Module(bytes);
    const first = new target.WebAssembly.Instance(module);
    const second = await target.WebAssembly.instantiate(module);
    const third = await target.WebAssembly.instantiate(bytes);
    expect(first.exports.memory).toBeInstanceOf(WebAssembly.Memory);
    expect(second).toBeInstanceOf(WebAssembly.Instance);
    expect(third.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(probe.snapshot()).toMatchObject({
      status: "complete",
      observedCount: 3,
      liveCount: 3,
      totalBytes: 3 * 65536,
    });
  });

  it("preserves native errors and marks overflow incomplete instead of silently truncating", async () => {
    const target = scope();
    const probe = installWasmMemoryProbe(target, 1);
    let nativeError: unknown;
    try {
      new WebAssembly.Memory({ initial: -1 });
    } catch (error) {
      nativeError = error;
    }
    expect(nativeError).toBeInstanceOf(Error);
    expect(() => new target.WebAssembly.Memory({ initial: -1 })).toThrow(
      nativeError as Error,
    );
    await expect(
      target.WebAssembly.instantiate(new Uint8Array([0])),
    ).rejects.toThrow(WebAssembly.CompileError);
    const first = new target.WebAssembly.Memory({ initial: 1 });
    const second = new target.WebAssembly.Memory({ initial: 1 });
    expect(first.buffer.byteLength + second.buffer.byteLength).toBe(131072);
    expect(probe.snapshot().status).toBe("incomplete");
  });
});
