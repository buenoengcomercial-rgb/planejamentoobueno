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

// WHIP! color indexes use Autodesk's 256-entry DWF palette, not DXF ACI.
// Sources: whiptk/palette.h, colormap.cpp, color.cpp and wversion.h (revision 38).
// True-color records keep their original RGBA values; an explicit ColorMap
// replaces the default palette for subsequent indexed colors.
const colorParserSource = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
const colorSegments = [
  ['        this.decimalRevision = 600;', '        this.decimalRevision = 600;\n        this.colorMap = undefined; // ObraPlanner: WHIP indexed-color rendition.'],
  ['aciColor(this.readAsciiInteger())', 'this.indexedColor(this.readAsciiInteger())'],
  ['aciColor(this.u8())', 'this.indexedColor(this.u8())'],
  ['    parseExtendedAscii(start) {', `    indexedColor(index) {
        if (this.colorMap)
            return this.colorMap[index] ?? 'rgba(0, 0, 0, 0)';
        return whipDefaultColor(index, this.decimalRevision);
    }
    parseExtendedAscii(start) {`],
  ["            case '(Color': {", `            case '(ColorMap': {
                const values = numbers(expr);
                const count = values[0];
                if (!Number.isInteger(count) || count < 1 || count > 256 || values.length !== 1 + count * 4)
                    throw new Error('Invalid WHIP ASCII ColorMap.');
                this.colorMap = [];
                for (let i = 0; i < count; i++) {
                    const n = 1 + i * 4;
                    this.colorMap.push(rgba(values[n], values[n + 1], values[n + 2], values[n + 3]));
                }
                break;
            }
            case '(Color': {`],
  ['        const opcode = this.u16();', `        const opcode = this.u16();
        if (opcode === 0x0001) { // WHIP ColorMap: uint8 count (0 = 256), RGBA entries, closing brace.
            const countByte = this.u8();
            const count = countByte || 256;
            if (size !== 4 + count * 4 || this.remaining() < count * 4 + 1)
                throw new Error('Invalid WHIP binary ColorMap size.');
            const colors = [];
            for (let i = 0; i < count; i++)
                colors.push(rgba(this.u8(), this.u8(), this.u8(), this.u8()));
            if (this.u8() !== 0x7d)
                throw new Error('Invalid WHIP binary ColorMap closing brace.');
            this.colorMap = colors;
            return true;
        }`],
  ['            else if (c === 0x22 || c === 0x27) {\n                quote = c;', `            else if (c === 0x7b) {
                // ObraPlanner: binary WHIP strings contain a character count and UTF-16LE data.
                // Length/payload bytes can equal quotes or parentheses, so skip them as one operand.
                const count = this.i32();
                if (count < 0 || count > Math.floor((this.remaining() - 1) / 2))
                    throw new Error('Truncated binary WHIP string in expression.');
                this.pos += count * 2;
                if (this.u8() !== 0x7d)
                    throw new Error('Invalid binary WHIP string closing brace.');
            }
            else if (c === 0x22 || c === 0x27) {
                quote = c;`],
  ['function aciColor(index) {', `function whipDefaultColor(index, revision) {
    // Preserve the upstream behavior for pre-revision-38 legacy palettes.
    if (revision < 38)
        return aciColor(index);
    if (!Number.isInteger(index) || index < 0 || index > 255)
        return 'rgba(0, 0, 0, 0)';
    if (index < 10) {
        const base = [[0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0], [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192], [192, 220, 192], [166, 202, 240]];
        return rgb(...base[index]);
    }
    if (index < 226) {
        const cube = index - 10;
        return rgb(Math.floor(cube / 36) * 51, (Math.floor(cube / 6) % 6) * 51, (cube % 6) * 51);
    }
    if (index < 246) {
        const gray = Math.floor((index - 226) * 255 / 19);
        return rgb(gray, gray, gray);
    }
    const tail = [[255, 251, 240], [160, 160, 164], [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255]];
    return rgb(...tail[index - 246]);
}
function aciColor(index) {`],
];
let coloredParser = colorParserSource;
let colorChanges = 0;
for (const [before, after] of colorSegments) {
  if (coloredParser.split(after).length === 2) continue;
  if (coloredParser.split(before).length !== 2) {
    throw new Error('The dwf-viewer binary parser differs from the reviewed 0.6.7 source. The WHIP color/string patch was not applied.');
  }
  coloredParser = coloredParser.replace(before, after);
  colorChanges++;
}
if (colorChanges) {
  writeFileSync(target, coloredParser, 'utf8');
  console.log('Applied WHIP palette, ColorMap and Unicode-expression compatibility patches.');
} else {
  console.log('WHIP palette, ColorMap and Unicode-expression patches already applied.');
}
