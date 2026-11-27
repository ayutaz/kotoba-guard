import { describe, expect, it } from "vitest";
import {
  isSensitiveEditable,
  isSupportedEditable,
  readEditableText,
} from "./exclusions";

describe("editable safety gate", () => {
  it("rejects password and OTP fields", () => {
    document.body.innerHTML =
      '<input id="password" type="password"><input id="otp" autocomplete="one-time-code">';
    expect(isSensitiveEditable(document.querySelector("#password")!)).toBe(
      true,
    );
    expect(isSensitiveEditable(document.querySelector("#otp")!)).toBe(true);
  });

  it("rejects an editor inside a credential form", () => {
    document.body.innerHTML =
      '<form autocomplete="current-password"><textarea id="editor"></textarea></form>';
    expect(isSensitiveEditable(document.querySelector("#editor")!)).toBe(true);
  });

  it("supports ordinary text fields and contenteditable", () => {
    document.body.innerHTML =
      '<input id="text" type="text" value="本文"><div id="ce" contenteditable="true">本文</div>';
    const text = document.querySelector("#text")!;
    const contenteditable = document.querySelector("#ce")!;
    expect(isSupportedEditable(text)).toBe(true);
    expect(isSupportedEditable(contenteditable)).toBe(true);
    expect(readEditableText(text as HTMLInputElement)).toBe("本文");
    expect(readEditableText(contenteditable as HTMLElement)).toBe("本文");
  });

  it("does not inspect hidden or file fields", () => {
    document.body.innerHTML =
      '<input id="hidden" type="hidden"><input id="file" type="file">';
    expect(isSupportedEditable(document.querySelector("#hidden"))).toBe(false);
    expect(isSupportedEditable(document.querySelector("#file"))).toBe(false);
  });
});
