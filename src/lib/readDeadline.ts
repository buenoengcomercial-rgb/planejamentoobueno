/** Deadlines apply to reads only; writes must still await server confirmation. */
export const OPENING_TIMEOUT_MS = 30_000;

export async function withReadDeadline<T>(read: PromiseLike<T>, timeoutMs = OPENING_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      Promise.resolve(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('O servidor demorou para responder. Tente novamente.')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
