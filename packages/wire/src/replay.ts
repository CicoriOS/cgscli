/** Bounded per-stream delta window. `since(seq)` returns deltas after `seq`, or null when the caller must send a snapshot. */
export class ReplayBuffer<T> {
  private items: { seq: number; v: T }[] = [];
  private next = 1;
  constructor(private capacity = 1024) {}

  /** Append, returning the assigned monotonically increasing seq. */
  push(v: T): number {
    const seq = this.next++;
    this.items.push({ seq, v });
    if (this.items.length > this.capacity) this.items.shift();
    return seq;
  }

  get lastSeq(): number { return this.next - 1; }

  since(seq: number): { seq: number; v: T }[] | null {
    if (seq >= this.lastSeq) return seq > this.lastSeq ? null : [];
    const first = this.items[0];
    if (!first || seq < first.seq - 1) return null;
    return this.items.filter((i) => i.seq > seq);
  }
}
