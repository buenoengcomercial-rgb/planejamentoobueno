import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// dwf-viewer 0.6.7 stops classic W2D V6.00 streams at the first Polymarker16.
// Autodesk WHIP! Toolkit: opcode.cpp / polymark.cpp, opcode 0x8d uses a 16-bit
// relative point set before revision 601 (later revisions reuse it for macros).
// Keep the upstream renderer, and emit independent colored dots for this record.
const require = createRequire(import.meta.url);
const packagePath = require.resolve('dwf-viewer/package.json');
const { version } = JSON.parse(readFileSync(packagePath, 'utf8'));
if (version !== '0.6.7') throw new Error(`DWF compatibility patch requires dwf-viewer 0.6.7; found ${version}. Review the reader before upgrading.`);

const target = join(dirname(packagePath), 'dist/format/w2dBinary.js');
const source = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const original = '        switch (opcode) {\n            case 0x00:';
const patched = `        switch (opcode) {
            // ObraPlanner: classic W2D V6.00 Polymarker16 compatibility.
            case 0x8d: {
                if (this.decimalRevision >= 601)
                    return false; // Macro_Draw requires its own decoder, not dots.
                const points = this.pointSet16Relative();
                if (this.state.visible) {
                    const size = Math.max(0.2, this.state.lineWidth);
                    for (const point of points) {
                        this.primitives.push({ type: 'rect', x: point.x - size / 2, y: point.y - size / 2, width: size, height: size, fill: this.state.stroke, lineWidth: size, obraplannerPolymarker: true });
                    }
                }
                return true;
            }
            case 0x00:`;

if (source.includes(patched)) {
  console.log('DWF V6.00 compatibility patch already applied.');
} else {
  if (source.includes('ObraPlanner: classic W2D V6.00') || source.split(original).length !== 2) {
    throw new Error('The dwf-viewer parser differs from the reviewed 0.6.7 source. The compatibility patch was not applied.');
  }
  writeFileSync(target, source.replace(original, patched), 'utf8');
  console.log('Applied DWF V6.00 Polymarker16 compatibility patch.');
}

// The completed Model sheet can contain hundreds of thousands of primitives.
// Passing them as function arguments overflows the JS call stack; append the
// same records in order without spreading the array into push().
const loaderTarget = join(dirname(packagePath), 'dist/format/dwf.js');
const loaderSource = readFileSync(loaderTarget, 'utf8').replace(/\r\n/g, '\n');
const loaderOriginal = 'primitives.push(...parsed.primitives);';
const loaderPatched = '/* ObraPlanner: append large DWF sheets without argument overflow. */ for (const primitive of parsed.primitives) primitives.push(primitive);';
if (loaderSource.split(loaderPatched).length === 3 && !loaderSource.includes(loaderOriginal)) {
  console.log('DWF large-sheet patch already applied.');
} else {
  if (loaderSource.includes('ObraPlanner: append large DWF') || loaderSource.split(loaderOriginal).length !== 3) {
    throw new Error('The dwf-viewer classic loader differs from the reviewed 0.6.7 source. The large-sheet patch was not applied.');
  }
  writeFileSync(loaderTarget, loaderSource.replaceAll(loaderOriginal, loaderPatched), 'utf8');
  console.log('Applied DWF large-sheet compatibility patch.');
}

// Zero-size/very thin legacy point markers still represent visible dots. Match
// the existing adaptive stroke policy when rendering them, without changing
// fills, line weights or shapes belonging to other drawing primitives.
const rendererTarget = join(dirname(packagePath), 'dist/render/W2dRenderer.js');
const rendererSource = readFileSync(rendererTarget, 'utf8').replace(/\r\n/g, '\n');
const rendererOriginal = "        else if (p.type === 'rect') {\n            if (fill) {";
const rendererPatched = `        else if (p.type === 'rect') {
            // ObraPlanner: render classic point markers at the adaptive pixel size.
            if (p.obraplannerPolymarker === true) {
                ctx.fillStyle = fill ?? stroke;
                ctx.beginPath();
                ctx.arc(p.x + p.width / 2, p.y + p.height / 2, ctx.lineWidth / 2, 0, Math.PI * 2);
                ctx.fill();
            }
            else if (fill) {`;
if (rendererSource.includes(rendererPatched)) {
  console.log('DWF point-marker rendering patch already applied.');
} else {
  if (rendererSource.includes('ObraPlanner: render classic point markers') || rendererSource.split(rendererOriginal).length !== 2) {
    throw new Error('The dwf-viewer Canvas2D renderer differs from the reviewed 0.6.7 source. The point-marker patch was not applied.');
  }
  writeFileSync(rendererTarget, rendererSource.replace(rendererOriginal, rendererPatched), 'utf8');
  console.log('Applied DWF point-marker rendering patch.');
}
