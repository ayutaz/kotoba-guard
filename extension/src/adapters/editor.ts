import { isSensitiveEditable } from "../content/exclusions";

export type EditorElement =
  HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export interface EditorAdapter {
  readonly name: "textarea" | "input" | "contenteditable";
  canHandle(element: Element): boolean;
  read(element: EditorElement): string;
}

const textareaAdapter: EditorAdapter = {
  name: "textarea",
  canHandle: (element) => element instanceof HTMLTextAreaElement,
  read: (element) => (element as HTMLTextAreaElement).value,
};

const inputAdapter: EditorAdapter = {
  name: "input",
  canHandle: (element) =>
    element instanceof HTMLInputElement &&
    ["text", "search", "email", "url", "tel"].includes(
      element.type.toLowerCase(),
    ),
  read: (element) => (element as HTMLInputElement).value,
};

const contentEditableAdapter: EditorAdapter = {
  name: "contenteditable",
  canHandle: (element) =>
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      element.getAttribute("contenteditable") === "true" ||
      element.getAttribute("contenteditable") === "plaintext-only" ||
      element.getAttribute("contenteditable") === ""),
  read: (element) => (element as HTMLElement).textContent ?? "",
};

export const editorAdapters: readonly EditorAdapter[] = [
  textareaAdapter,
  inputAdapter,
  contentEditableAdapter,
];

/** Select an adapter without reading user content. Sensitive editors are rejected first. */
export function adapterFor(element: Element): EditorAdapter | undefined {
  if (isSensitiveEditable(element)) return undefined;
  return editorAdapters.find((adapter) => adapter.canHandle(element));
}

/** Read only after adapter selection and a fresh sensitive-field check. */
export function readWithAdapter(
  element: EditorElement,
  adapter = adapterFor(element),
): string | undefined {
  if (!adapter || isSensitiveEditable(element)) return undefined;
  return adapter.read(element);
}

export function editorFromTarget(
  target: EventTarget | null,
):
  | { readonly element: EditorElement; readonly adapter: EditorAdapter }
  | undefined {
  if (!(target instanceof Element)) return undefined;
  const candidates = [
    target,
    target.closest(
      '[contenteditable="true"], [contenteditable="plaintext-only"], textarea, input',
    ),
  ].filter((candidate): candidate is Element => candidate instanceof Element);
  for (const candidate of candidates) {
    const adapter = adapterFor(candidate);
    if (adapter) return { element: candidate as EditorElement, adapter };
  }
  return undefined;
}
