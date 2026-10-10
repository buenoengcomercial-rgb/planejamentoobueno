import type { Point } from './planTakeoff';
import { isDxfModelEntity } from './dxfModel';

export const CAPTURE_KINDS = ['point', 'endpoint', 'insertion', 'center', 'perpendicular', 'parallel', 'midpoint', 'intersection', 'quadrant', 'nearest', 'extension'] as const;
export type CaptureKind = typeof CAPTURE_KINDS[number];
export const CAPTURE_LABELS: Record<CaptureKind, string> = {
  point: 'Ponto', endpoint: 'Extremo', insertion: 'Ponto de inserção', center: 'Centro',
  perpendicular: 'Perpendicular', parallel: 'Paralelo', midpoint: 'Ponto médio',
  intersection: 'Interseção', quadrant: 'Quadrante', nearest: 'Ponto mais próximo', extension: 'Extensão',
};
interface Visibility { layer: string; parentLayers?: string[] }
interface Segment extends Visibility { a: Point; b: Point }
interface Anchor extends Visibility { point: Point; kind: CaptureKind }
interface Circle extends Visibility { center: Point; radius: number; startAngle?: number; sweepAngle?: number }
export interface DxfGeometry { segments: Segment[]; anchors: Anchor[]; circles: Circle[]; available: CaptureKind[] }
export interface SnapHit { point: Point; kind: CaptureKind; guide?: { from: Point; to: Point } }
export interface TrackingHit { point: Point; from: Point; axes: ('x' | 'y')[] }
export function trackAlignment(target: Point, from: Point, tolerance: number): TrackingHit | null {
  const axes: ('x' | 'y')[] = [];
  const result = { ...target };
  if (Math.abs(target.x - from.x) < tolerance) { result.x = from.x; axes.push('x'); }
  if (Math.abs(target.y - from.y) < tolerance) { result.y = from.y; axes.push('y'); }
  return axes.length ? { point: result, from, axes } : null;
}

type Transform = { a: number; b: number; c: number; d: number; x: number; y: number };
const identity: Transform = { a: 1, b: 0, c: 0, d: 1, x: 0, y: 0 };
const apply = (p: Point, t: Transform): Point => ({ x: t.a * p.x + t.c * p.y + t.x, y: t.b * p.x + t.d * p.y + t.y });
const compose = (p: Transform, t: Transform): Transform => ({ a: p.a * t.a + p.c * t.b, b: p.b * t.a + p.d * t.b, c: p.a * t.c + p.c * t.d, d: p.b * t.c + p.d * t.d, x: p.a * t.x + p.c * t.y + p.x, y: p.b * t.x + p.d * t.y + p.y });
const turn = Math.PI * 2;
const positiveAngle = (angle: number) => (angle % turn + turn) % turn;
const onArc = (curve: Circle, p: Point) => curve.startAngle === undefined || curve.sweepAngle === undefined ||
  positiveAngle((Math.atan2(p.y - curve.center.y, p.x - curve.center.x) - curve.startAngle) * Math.sign(curve.sweepAngle)) <= Math.abs(curve.sweepAngle) + 1e-8;
const visible = (item: Visibility, hidden: ReadonlySet<string>) => !hidden.has(item.layer) && !item.parentLayers?.some(layer => hidden.has(layer));

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
  const document = parsed as { entities?: unknown[]; blocks?: Record<string, { entities?: unknown[]; position?: unknown }> } | null;
  const blocks = document?.blocks ?? {};
  const segments: Segment[] = [], anchors: Anchor[] = [], circles: Circle[] = [];
  const visit = (items: unknown[], transform: Transform, parents: string[], path: string[]) => { for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const entity = item as Record<string, unknown>;
    if (!isDxfModelEntity(entity)) continue;
    const rawLayer = typeof entity.layer === 'string' ? entity.layer : '0';
    const layer = rawLayer === '0' && parents.length ? parents.at(-1)! : rawLayer;
    const visibility = { layer, parentLayers: parents };
    const type = entity.type;
    const rawVertices = Array.isArray(entity.vertices) ? entity.vertices : [];
    const mapPoint = (value: unknown) => { const p = point(value); return p ? apply(p, transform) : null; };
    const vertices = rawVertices.map(mapPoint).filter((value): value is Point => !!value);
    const addAnchor = (p: Point, kind: CaptureKind) => anchors.push({ point: p, kind, ...visibility });
    const addSegment = (a: Point, b: Point) => {
      if (distance(a, b) < 1e-9) return;
      segments.push({ a, b, ...visibility });
      addAnchor(a, 'endpoint'); addAnchor(b, 'endpoint'); addAnchor({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, 'midpoint');
    };
    const addCurve = (center: Point, radius: number, start = 0, sweep = turn, full = true) => {
      const at = (angle: number) => apply({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }, transform);
      const worldCenter = apply(center, transform);
      addAnchor(worldCenter, 'center');
      if (!full) { addAnchor(at(start), 'endpoint'); addAnchor(at(start + sweep), 'endpoint'); addAnchor(at(start + sweep / 2), 'midpoint'); }
      const sx = Math.hypot(transform.a, transform.b), sy = Math.hypot(transform.c, transform.d);
      // A nonuniformly scaled circle is an ellipse; do not claim circular snaps for it.
      if (Math.abs(sx - sy) > Math.max(sx, sy) * 1e-8 || Math.abs(transform.a * transform.c + transform.b * transform.d) > sx * sy * 1e-8) return;
      const first = at(start);
      const curve: Circle = { center: worldCenter, radius: radius * sx, ...visibility, ...(!full ? { startAngle: Math.atan2(first.y - worldCenter.y, first.x - worldCenter.x), sweepAngle: sweep * Math.sign(transform.a * transform.d - transform.b * transform.c) } : {}) };
      circles.push(curve);
      for (const [x, y] of [[curve.radius, 0], [-curve.radius, 0], [0, curve.radius], [0, -curve.radius]]) {
        const p = { x: worldCenter.x + x, y: worldCenter.y + y };
        if (onArc(curve, p)) addAnchor(p, 'quadrant');
      }
    };
    if (type === 'LINE') {
      const a = vertices[0] ?? mapPoint(entity.start), b = vertices[1] ?? mapPoint(entity.end);
      if (a && b) addSegment(a, b);
    } else if (type === 'LWPOLYLINE' || type === 'POLYLINE') {
      const local = rawVertices.map(point);
      const count = (entity.shape || entity.closed) && vertices.length > 2 ? local.length : local.length - 1;
      for (let index = 0; index < count; index++) {
        const a = local[index], b = local[(index + 1) % local.length];
        if (!a || !b) continue;
        const bulge = (rawVertices[index] as { bulge?: number }).bulge ?? 0;
        if (!finite(bulge) || Math.abs(bulge) < 1e-9) { addSegment(apply(a, transform), apply(b, transform)); continue; }
        const dx = b.x - a.x, dy = b.y - a.y;
        const center = { x: (a.x + b.x) / 2 + dy * (1 - bulge * bulge) / (4 * bulge), y: (a.y + b.y) / 2 - dx * (1 - bulge * bulge) / (4 * bulge) };
        addCurve(center, distance(a, center), Math.atan2(a.y - center.y, a.x - center.x), -4 * Math.atan(bulge), false);
      }
    } else if (type === 'CIRCLE' || type === 'ARC') {
      const center = point(entity.center), radius = entity.radius;
      if (center && finite(radius) && radius > 0) {
        if (type === 'CIRCLE') addCurve(center, radius);
        else if (finite(entity.startAngle) && finite(entity.endAngle)) addCurve(center, radius, -entity.startAngle, -positiveAngle(entity.endAngle - entity.startAngle), false);
      }
    } else if (type === 'INSERT') {
      const insertion = point(entity.position);
      if (insertion) {
        addAnchor(apply(insertion, transform), 'insertion');
        const name = typeof entity.name === 'string' ? entity.name : '';
        const block = blocks[name];
        if (block && !path.includes(name) && path.length < 32) {
          const base = point(block.position) ?? { x: 0, y: 0 };
          const angle = -(finite(entity.rotation) ? entity.rotation : 0) * Math.PI / 180;
          const sx = finite(entity.xScale) ? entity.xScale : 1, sy = finite(entity.yScale) ? entity.yScale : 1;
          const next = { a: Math.cos(angle) * sx, b: Math.sin(angle) * sx, c: -Math.sin(angle) * sy, d: Math.cos(angle) * sy, x: 0, y: 0 };
          next.x = insertion.x - next.a * base.x - next.c * base.y;
          next.y = insertion.y - next.b * base.x - next.d * base.y;
          visit(block.entities ?? [], compose(transform, next), [...parents, layer], [...path, name]);
        }
      }
    } else if (type === 'POINT') {
      const dot = mapPoint(entity.position);
      if (dot) addAnchor(dot, 'point');
    }
  } };
  visit(document?.entities ?? [], identity, [], []);
  const available = CAPTURE_KINDS.filter(kind => kind === 'point' || kind === 'endpoint' || kind === 'insertion' || kind === 'center' || kind === 'midpoint' || kind === 'quadrant'
    ? anchors.some(anchor => anchor.kind === kind)
    : kind === 'intersection' ? segments.length >= 2
      : kind === 'nearest' ? !!(segments.length || circles.length) : segments.length > 0);
  return { segments, anchors, circles, available };
}

export function snapDxf(target: Point, geometry: DxfGeometry, enabled: ReadonlySet<CaptureKind>, tolerance: number, hiddenLayers: ReadonlySet<string>, previous?: Point, tracking = false): SnapHit | null {
  let best: SnapHit | null = null, bestDistance = tolerance;
  const offer = (candidate: Point, kind: CaptureKind, guide?: SnapHit['guide']) => {
    if (!enabled.has(kind)) return;
    const gap = distance(candidate, target);
    if (gap < bestDistance) { best = { point: candidate, kind, ...(tracking && guide ? { guide } : {}) }; bestDistance = gap; }
  };
  for (const anchor of geometry.anchors) if (visible(anchor, hiddenLayers)) offer(anchor.point, anchor.kind);
  const nearby: Segment[] = [];
  for (const segment of geometry.segments) {
    if (!visible(segment, hiddenLayers)) continue;
    if (enabled.has('nearest') || enabled.has('intersection') || enabled.has('perpendicular') || enabled.has('parallel') || enabled.has('extension')) {
      const projected = projection(target, segment.a, segment.b, true);
      if (projected && distance(projected.point, target) <= tolerance * 2) {
        nearby.push(segment);
        offer(projected.point, 'nearest');
      }
    }
    if (previous) {
      if (enabled.has('perpendicular')) {
        const foot = projection(previous, segment.a, segment.b, false);
        if (foot && foot.t >= 0 && foot.t <= 1) offer(foot.point, 'perpendicular', { from: previous, to: foot.point });
      }
      if (enabled.has('parallel')) {
        const translated = { x: previous.x + segment.b.x - segment.a.x, y: previous.y + segment.b.y - segment.a.y };
        const parallel = projection(target, previous, translated, false);
        if (parallel) offer(parallel.point, 'parallel', { from: previous, to: parallel.point });
      }
    }
    if (enabled.has('extension')) {
      const extended = projection(target, segment.a, segment.b, false);
      if (extended && (extended.t < 0 || extended.t > 1)) offer(extended.point, 'extension', { from: extended.t < 0 ? segment.a : segment.b, to: extended.point });
    }
  }
  if (enabled.has('intersection')) for (let first = 0; first < Math.min(nearby.length, 30); first++)
    for (let second = first + 1; second < Math.min(nearby.length, 30); second++) {
      const hit = crossing(nearby[first], nearby[second]);
      if (hit) offer(hit, 'intersection');
    }
  if (enabled.has('nearest')) for (const circle of geometry.circles) {
    if (!visible(circle, hiddenLayers)) continue;
    const dx = target.x - circle.center.x, dy = target.y - circle.center.y;
    const radius = Math.hypot(dx, dy);
    if (radius) {
      const candidate = { x: circle.center.x + dx / radius * circle.radius, y: circle.center.y + dy / radius * circle.radius };
      if (onArc(circle, candidate)) offer(candidate, 'nearest');
    }
  }
  return best;
}
