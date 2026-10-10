/** Keep the original upload intact; only the viewer's working copy is filtered. */
export function dxfModelOnly(source: string): string {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
  const records: { type: string; start: number; end: number; fields: Map<number, string[]>; section: string }[] = [];
  let section = '', current: typeof records[number] | undefined;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()), value = lines[i + 1].trim();
    if (code === 0) {
      current = { type: value.toUpperCase(), start: i, end: i, fields: new Map(), section };
      records.push(current);
    }
    if (!current) throw new Error('DXF inválido: pares de grupos incompletos.');
    current.end = i + 2;
    if ([2, 5, 67, 330, 410].includes(code)) current.fields.set(code, [...(current.fields.get(code) ?? []), value]);
    if (current.type === 'SECTION' && code === 2) section = value.toUpperCase();
    if (current.type === 'ENDSEC') section = '';
  }
  const paperOwners = new Set(records.filter(r => r.type === 'BLOCK_RECORD' &&
    r.fields.get(2)?.some(name => /^\*PAPER_SPACE/i.test(name)))
    .flatMap(r => r.fields.get(5) ?? []).map(handle => handle.toUpperCase()));
  let skipChildren = false;
  return records.filter(record => {
    if (record.section !== 'ENTITIES' || record.type === 'ENDSEC') return true;
    if (record.type === 'VERTEX' || record.type === 'ATTRIB' || record.type === 'SEQEND') {
      const skip = skipChildren;
      if (record.type === 'SEQEND') skipChildren = false;
      return !skip;
    }
    const paper = record.fields.get(67)?.some(value => Number(value) !== 0) ||
      record.fields.get(410)?.some(name => name.toUpperCase() !== 'MODEL') ||
      record.fields.get(330)?.some(owner => paperOwners.has(owner.toUpperCase()));
    skipChildren = !!paper;
    return !paper;
  }).map(record => lines.slice(record.start, record.end).join('\n')).join('\n') + '\n';
}

export function isDxfModelEntity(entity: Record<string, unknown>): boolean {
  if (entity.inPaperSpace || (entity.paperSpace !== undefined && Number(entity.paperSpace) !== 0)) return false;
  const layout = entity.layout ?? entity.layoutName;
  return typeof layout !== 'string' || layout.toUpperCase() === 'MODEL';
}
