import { describe, expect, it, vi } from "vitest";
import { adapterFor, editorFromTarget, readWithAdapter } from "./editor";

describe("editor adapters", () => {
  it("reads textarea, text input, and contenteditable through their adapters", () => {
    document.body.innerHTML =
      '<textarea id="area">textarea</textarea><input id="input" value="input"><div id="rich" contenteditable="true">rich</div>';
    const area = document.querySelector<HTMLTextAreaElement>("#area")!;
    const input = document.querySelector<HTMLInputElement>("#input")!;
    const rich = document.querySelector<HTMLElement>("#rich")!;
    expect(readWithAdapter(area)).toBe("textarea");
    expect(readWithAdapter(input)).toBe("input");
    expect(readWithAdapter(rich)).toBe("rich");
  });

  it("rejects sensitive editors before the adapter read function runs", () => {
    document.body.innerHTML =
      '<input id="secret" type="password" value="secret">';
    const secret = document.querySelector<HTMLInputElement>("#secret")!;
    const adapter = adapterFor(secret);
    const read = vi.fn().mockReturnValue(secret.value);
    expect(adapter).toBeUndefined();
    expect(
      readWithAdapter(secret, { name: "input", canHandle: () => true, read }),
    ).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it("finds an editor added after initial page setup", () => {
    document.body.innerHTML = '<main id="root"></main>';
    const root = document.querySelector("#root")!;
    const editor = document.createElement("textarea");
    editor.value = "動的入力";
    root.append(editor);
    const selected = editorFromTarget(editor);
    expect(selected?.adapter.name).toBe("textarea");
    expect(readWithAdapter(selected!.element, selected!.adapter)).toBe(
      "動的入力",
    );
  });
});
