import type { Point } from './planTakeoff';

export const CAPTURE_KINDS = ['point', 'endpoint', 'insertion', 'center', 'perpendicular', 'parallel', 'midpoint', 'intersection', 'quadrant', 'nearest', 'extension'] as const;
export type CaptureKind = typeof CAPTURE_KINDS[number];
export const CAPTURE_LABELS: Record<CaptureKind, string> = {
  point: 'Ponto', endpoint: 'Extremo', insertion: 'Ponto de inserção', center: 'Centro',
  perpendicular: 'Perpendicular', parallel: 'Paralelo', midpoint: 'Ponto médio',
  intersection: 'Interseção', quadrant: 'Quadrante', nearest: 'Ponto mais próximo', extension: 'Extensão',
};
interface Segment { a: Point; b: Point; layer: string }
interface Anchor { point: Point; kind: CaptureKind; layer: string }
interface Circle { center: Point; radius: number; layer: string }
export interface DxfGeometry { segments: Segment[]; anchors: Anchor[]; circles: Circle[]; available: CaptureKind[] }
export interface SnapHit { point: Point; kind: CaptureKind }

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
function point(value: unknown): Point | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as { x?: unknown; y?: unknown };
  return finite(source.x) && finite(source.y) ? { x: source.x, y: -source.y } : null;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function projection(target: Point, a: Point, b: Point, bounded: boolean): { point: Point; t: number } | null {
  const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  if (!length2) return null;
  const raw = ((target.x - a.x) * dx + (target.y - a.y) * dy) / length2;
  const t = bounded ? Math.max(0, Math.min(1, raw)) : raw;
  return { point: { x: a.x + t * dx, y: a.y + t * dy }, t: raw };
}
function crossing(first: Segment, second: Segment): Point | null {
  const ax = first.b.x - first.a.x, ay = first.b.y - first.a.y;
  const bx = second.b.x - second.a.x, by = second.b.y - second.a.y;
  const determinant = ax * by - ay * bx;
  if (Math.abs(determinant) < 1e-12) return null;
  const cx = second.a.x - first.a.x, cy = second.a.y - first.a.y;
  const t = (cx * by - cy * bx) / determinant;
  const u = (cx * ay - cy * ax) / determinant;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: first.a.x + t * ax, y: first.a.y + t * ay } : null;
}

/** DXF model-space coordinates are mapped to the canvas's downwards Y axis. */
export function extractDxfGeometry(parsed: unknown): DxfGeometry {
  const entities = (parsed as { entities?: unknown[] } | null)?.entities ?? [];
  const segments: Segment[] = [], anchors: Anchor[] = [], circles: Circle[] = [];
  for (const item of entities) {
    if (!item || typeof item !== 'object') continue;
    const entity = item as Record<string, unknown>;
    const layer = typeof entity.layer === 'string' ? entity.layer : '0';
    const type = entity.type;
    const rawVertices = Array.isArray(entity.vertices) ? entity.vertices : [];
    const vertices = rawVertices.map(point).filter((value): value is Point => !!value);
    const addSegment = (a: Point, b: Point) => {
      if (distance(a, b) < 1e-9) return;
      segments.push({ a, b, layer });
      anchors.push({ point: a, kind: 'endpoint', layer }, { point: b, kind: 'endpoint', layer },
        { point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'midpoint', layer });
    };
    if (type === 'LINE') {
      const a = vertices[0] ?? point(entity.start), b = vertices[1] ?? point(entity.end);
      if (a && b) addSegment(a, b);
    } else if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
      for (let index = 1; index < vertices.length; index++) addSegment(vertices[index - 1], vertices[index]);
      if ((entity.shape || entity.closed) && vertices.length > 2) addSegment(vertices.at(-1)!, vertices[0]);
    } else if (type === 'CIRCLE' || type === 'ARC') {
      const center = point(entity.center), radius = entity.radius;
      if (center && finite(radius) && radius > 0) {
        circles.push({ center, radius, layer });
        anchors.push({ point: center, kind: 'center', layer });
        if (type === 'CIRCLE') for (const [x, y] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]])
          anchors.push({ point: { x: center.x + x, y: center.y + y }, kind: 'quadrant', layer });
      }
    } else if (type === 'INSERT') {
      const insertion = point(entity.position);
      if (insertion) anchors.push({ point: insertion, kind: 'insertion', layer });
    } else if (type === 'POINT') {
      const dot = point(entity.position);
      if (dot) anchors.push({ point: dot, kind: 'point', layer });
    }
  }
  const available = CAPTURE_KINDS.filter(kind => kind === 'point' || kind === 'endpoint' || kind === 'insertion' || kind === 'center' || kind === 'midpoint' || kind === 'quadrant'
    ? anchors.some(anchor => anchor.kind === kind)
    : kind === 'intersection' ? segments.length >= 2
      : kind === 'nearest' ? !!(segments.length || circles.length) : segments.length > 0);
  return { segments, anchors, circles, available };
}

export function snapDxf(target: Point, geometry: DxfGeometry, enabled: ReadonlySet<CaptureKind>, tolerance: number, hiddenLayers: ReadonlySet<string>, previous?: Point, tracking = false): SnapHit | null {
  let best: SnapHit | null = null, bestDistance = tolerance;
  const offer = (candidate: Point, kind: CaptureKind) => {
    if (!enabled.has(kind)) return;
    const gap = distance(candidate, target);
    if (gap < bestDistance) { best = { point: candidate, kind }; bestDistance = gap; }
  };
  for (const anchor of geometry.anchors) if (!hiddenLayers.has(anchor.layer)) offer(anchor.point, anchor.kind);
  const nearby: Segment[] = [];
  for (const segment of geometry.segments) {
    if (hiddenLayers.has(segment.layer)) continue;
    if (enabled.has('nearest') || enabled.has('intersection') || enabled.has('perpendicular') || enabled.has('parallel') || enabled.has('extension')) {
      const projected = projection(target, segment.a, segment.b, true);
      if (projected && distance(projected.point, target) <= tolerance * 2) {
        nearby.push(segment);
        offer(projected.point, 'nearest');
      }
    }
    if (tracking && previous) {
      if (enabled.has('perpendicular')) {
        const foot = projection(previous, segment.a, segment.b, true);
        if (foot) offer(foot.point, 'perpendicular');
      }
      if (enabled.has('parallel')) {
        const translated = { x: previous.x + segment.b.x - segment.a.x, y: previous.y + segment.b.y - segment.a.y };
        const parallel = projection(target, previous, translated, false);
        if (parallel) offer(parallel.point, 'parallel');
      }
      if (enabled.has('extension')) {
        const extended = projection(target, segment.a, segment.b, false);
        if (extended && (extended.t < 0 || extended.t > 1)) offer(extended.point, 'extension');
      }
    }
  }
  if (enabled.has('intersection')) for (let first = 0; first < Math.min(nearby.length, 30); first++)
    for (let second = first + 1; second < Math.min(nearby.length, 30); second++) {
      const hit = crossing(nearby[first], nearby[second]);
      if (hit) offer(hit, 'intersection');
    }
  if (enabled.has('nearest')) for (const circle of geometry.circles) {
    if (hiddenLayers.has(circle.layer)) continue;
    const dx = target.x - circle.center.x, dy = target.y - circle.center.y;
    const radius = Math.hypot(dx, dy);
    if (radius) offer({ x: circle.center.x + dx / radius * circle.radius, y: circle.center.y + dy / radius * circle.radius }, 'nearest');
  }
  return best;
}
