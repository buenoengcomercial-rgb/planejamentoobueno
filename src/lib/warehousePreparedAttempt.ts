import { isWarehouseDefinitiveRejection } from './warehouseCloudCommit';

/** One immutable submission survives uncertain responses and double clicks. */
export class WarehousePreparedAttempt<T, R> {
  private pending?: { content: string; value: T };
  private inFlight?: Promise<{ result: R; previousDraft: boolean }>;

  run(content: string, prepare: () => Promise<T>, send: (attempt: T) => Promise<R>) {
    if (this.inFlight) return this.inFlight;
    const request = (async () => {
      try {
        this.pending ??= { content, value: await prepare() };
        const previousDraft = this.pending.content !== content;
        const result = await send(this.pending.value);
        this.pending = undefined;
        return { result, previousDraft };
      } catch (error) {
        if (isWarehouseDefinitiveRejection(error)) this.pending = undefined;
        throw error;
      }
    })();
    this.inFlight = request;
    return request.finally(() => { if (this.inFlight === request) this.inFlight = undefined; });
  }
}
