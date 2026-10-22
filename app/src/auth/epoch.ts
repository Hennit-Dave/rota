/**
 * The account epoch (app-state.md, "Signing out and switching accounts"). In memory only. Every request and every
 * persistence write captures the epoch when it starts; a result that arrives under an older epoch is discarded,
 * so a slow response for account A can never land in account B's caches.
 */
export class AccountEpoch {
  private value = 0;

  get current(): number {
    return this.value;
  }

  bump(): number {
    this.value += 1;
    return this.value;
  }

  isCurrent(captured: number): boolean {
    return captured === this.value;
  }
}
