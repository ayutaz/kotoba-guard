const SENSITIVE_WORDS =
  /(?:pass(?:word|wd|code)?|secret|otp|one[-_ ]?time|verification[-_ ]?code|auth(?:entication)?[-_ ]?code|security[-_ ]?code|credit[-_ ]?card|card[-_ ]?(?:number|no|cvc|cvv|csc)|cc[-_ ]?(?:number|name|exp|csc)|token)/i;
const SENSITIVE_AUTOCOMPLETE =
  /(?:current-password|new-password|one-time-code|cc-|credit-card|transaction-amount|webauthn)/i;

function attrValue(element: Element): string {
  return [
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    element.getAttribute("autocomplete"),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
}

function sensitiveAttributes(element: Element): boolean {
  const autocomplete = element.getAttribute("autocomplete") ?? "";
  const type = element.getAttribute("type") ?? "";
  return (
    type === "password" ||
    type === "hidden" ||
    type === "file" ||
    (type === "email" && SENSITIVE_WORDS.test(attrValue(element))) ||
    SENSITIVE_AUTOCOMPLETE.test(autocomplete) ||
    SENSITIVE_WORDS.test(attrValue(element))
  );
}

/** Safe default: reject an editor and any editor in a sensitive form subtree. */
export function isSensitiveEditable(element: Element): boolean {
  if (sensitiveAttributes(element)) return true;
  if (
    element.closest(
      'input[type="password"], input[type="hidden"], input[type="file"]',
    )
  )
    return true;
  let parent: Element | null = element.parentElement;
  while (parent) {
    if (
      parent.tagName === "FORM" &&
      (sensitiveAttributes(parent) || SENSITIVE_WORDS.test(attrValue(parent)))
    )
      return true;
    if (
      parent.getAttribute("aria-hidden") === "true" ||
      parent.hasAttribute("hidden")
    )
      return true;
    parent = parent.parentElement;
  }
  return false;
}

export function isEditable(
  element: Element,
): element is HTMLTextAreaElement | HTMLInputElement | HTMLElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return ["text", "search", "email", "url", "tel"].includes(
      element.type.toLowerCase(),
    );
  }
  return (
    element instanceof HTMLElement &&
    (element.isContentEditable ||
      element.getAttribute("contenteditable") === "true" ||
      element.getAttribute("contenteditable") === "plaintext-only" ||
      element.getAttribute("contenteditable") === "")
  );
}

export function isSupportedEditable(
  target: EventTarget | null,
): target is HTMLElement {
  return (
    target instanceof Element &&
    isEditable(target) &&
    !isSensitiveEditable(target)
  );
}

export function readEditableText(
  element: HTMLTextAreaElement | HTMLInputElement | HTMLElement,
): string {
  if (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement
  )
    return element.value;
  return element.textContent ?? "";
}
