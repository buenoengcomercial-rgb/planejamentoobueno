export type CountedPage<T> = { data: T[] | null; count: number | null; error: unknown };
/** Never label a truncated REST response as a complete collection. */
export async function readCompletePages<T extends { id: string }>(
  read: (after?: string, head?: boolean) => PromiseLike<CountedPage<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let after: string | undefined, total: number | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await read(after);
    if (page.error) throw page.error;
    if (!Array.isArray(page.data) || !Number.isSafeInteger(page.count) || page.count! < 0) throw new Error('Contagem completa não confirmada.');
    total ??= page.count!;
    if (total !== rows.length + page.count!) throw new Error('A coleção mudou durante a leitura.');
    for (const row of page.data) {
      if (!row.id || seen.has(row.id) || after && row.id <= after) throw new Error('Paginação fora de ordem ou duplicada.');
      seen.add(row.id); rows.push(row); after = row.id;
    }
    if (rows.length > total || !page.data.length && rows.length !== total) throw new Error('Coleção parcial.');
    if (rows.length === total) break;
  }
  const check = await read(undefined, true);
  if (check.error) throw check.error;
  if (check.count !== total) throw new Error('A coleção mudou antes da confirmação.');
  return rows;
}
