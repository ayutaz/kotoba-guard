export type Debounced<T extends (...args: never[]) => void> = {
  readonly schedule: (...args: Parameters<T>) => void;
  readonly cancel: () => void;
};

export function debounce<T extends (...args: never[]) => void>(
  callback: T,
  delayMs: number,
): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    schedule: (...args) => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        callback(...args);
      }, delayMs);
    },
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
