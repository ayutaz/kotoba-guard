export class BoundedQueue<T> {
  private readonly values: T[] = [];

  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("capacity must be positive");
  }

  get length(): number {
    return this.values.length;
  }
  get full(): boolean {
    return this.values.length >= this.capacity;
  }
  enqueue(value: T): boolean {
    if (this.full) return false;
    this.values.push(value);
    return true;
  }
  shift(): T | undefined {
    return this.values.shift();
  }
}
