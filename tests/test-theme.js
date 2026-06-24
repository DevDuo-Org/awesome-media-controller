// Run with: gjs -m tests/test-theme.js
import { extractPalette, rgbToHex, rgbToHsv, PRESETS, resolvePreset, ThemeManager } from '../lib/theme.js';

let failures = 0;
function assert(cond, msg) {
    if (cond) { print(`  ok: ${msg}`); } else { failures++; print(`FAIL: ${msg}`); }
}

// Build raw RGB pixel data for a WxH image from a fill function
function makePixels(w, h, fill) {
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const [r, g, b] = fill(x, y);
            const i = (y * w + x) * 3;
            px[i] = r; px[i + 1] = g; px[i + 2] = b;
        }
    }
    return px;
}

print('rgbToHex');
assert(rgbToHex({ r: 139, g: 92, b: 246 }) === '#8b5cf6', 'purple');
assert(rgbToHex({ r: 0, g: 0, b: 0 }) === '#000000', 'black');
assert(rgbToHex({ r: 300, g: -5, b: 255 }) === '#ff00ff', 'clamps out-of-range');

print('rgbToHsv');
assert(rgbToHsv(255, 0, 0).h === 0, 'red hue 0');
assert(Math.abs(rgbToHsv(0, 255, 0).h - 120) < 1, 'green hue 120');
assert(rgbToHsv(128, 128, 128).s === 0, 'gray has no saturation');

print('extractPalette');
const solid = makePixels(16, 16, () => [139, 92, 246]);
const p1 = extractPalette(solid, 3, 16 * 3, 16, 16);
assert(p1 !== null && p1.length === 2, 'solid purple yields two colors');
assert(p1[0] === '#8b5cf6', `primary matches source (got ${p1?.[0]})`);

const gray = makePixels(16, 16, () => [120, 120, 120]);
assert(extractPalette(gray, 3, 16 * 3, 16, 16) === null, 'monochrome gray yields null');

const duo = makePixels(16, 16, (x) => (x < 8 ? [220, 40, 40] : [40, 80, 220]));
const p2 = extractPalette(duo, 3, 16 * 3, 16, 16);
assert(p2 !== null, 'two-color image yields palette');
{
    const [a, b] = p2;
    const hueA = rgbToHsv(parseInt(a.slice(1, 3), 16), parseInt(a.slice(3, 5), 16), parseInt(a.slice(5, 7), 16)).h;
    const hueB = rgbToHsv(parseInt(b.slice(1, 3), 16), parseInt(b.slice(3, 5), 16), parseInt(b.slice(5, 7), 16)).h;
    assert(Math.min(Math.abs(hueA - hueB), 360 - Math.abs(hueA - hueB)) > 60, `accents are hue-distinct (${a} vs ${b})`);
}

// 4-channel (RGBA) data with transparent noise pixels that must be ignored
const rgba = new Uint8Array(8 * 8 * 4);
for (let i = 0; i < 64; i++) {
    const odd = i % 2 === 1;
    rgba[i * 4] = odd ? 255 : 30;        // transparent pixels are pure red
    rgba[i * 4 + 1] = odd ? 0 : 200;
    rgba[i * 4 + 2] = odd ? 0 : 90;
    rgba[i * 4 + 3] = odd ? 0 : 255;     // alpha
}
const p3 = extractPalette(rgba, 4, 8 * 4, 8, 8);
assert(p3 !== null && rgbToHsv(
    parseInt(p3[0].slice(1, 3), 16),
    parseInt(p3[0].slice(3, 5), 16),
    parseInt(p3[0].slice(5, 7), 16)
).h > 60, 'transparent pixels ignored (primary is green, not red)');

print('PRESETS');
const HEX = /^#[0-9a-f]{6}$/;
assert(Object.keys(PRESETS).length === 6, 'six built-in presets');
for (const [name, preset] of Object.entries(PRESETS)) {
    assert(typeof preset.label === 'string' && preset.label.length > 0, `${name} has a label`);
    assert(Array.isArray(preset.colors) && preset.colors.length === 2, `${name} has two colors`);
    assert(preset.colors.every((c) => HEX.test(c)), `${name} colors are lowercase hex`);
}

print('resolvePreset');
assert(resolvePreset('cyberpunk')[0] === '#00e5ff', 'finds preset by name');
assert(resolvePreset('does-not-exist')[0] === PRESETS['synthwave'].colors[0],
    'unknown name falls back to synthwave');

print('ThemeManager preset mode');
function fakeSettings(values) {
    return {
        get_string(key) { return values[key]; },
        connectObject() {},
        disconnectObject() {},
    };
}

const tmPreset = new ThemeManager(fakeSettings({
    'accent-mode': 'preset', 'theme-preset': 'cyberpunk',
    'accent-start': '#111111', 'accent-end': '#222222',
}));
assert(tmPreset.accentA === '#00e5ff', 'preset mode resolves accentA');
assert(tmPreset.accentB === '#ff00aa', 'preset mode resolves accentB');

const tmBad = new ThemeManager(fakeSettings({
    'accent-mode': 'preset', 'theme-preset': 'nonsense',
    'accent-start': '#111111', 'accent-end': '#222222',
}));
assert(tmBad.accentA === PRESETS['synthwave'].colors[0], 'bad preset name falls back');

const tmCustom = new ThemeManager(fakeSettings({
    'accent-mode': 'custom',
    'accent-start': '#111111', 'accent-end': '#222222',
}));
assert(tmCustom.accentA === '#111111', 'custom mode still uses settings colors');

if (failures > 0) {
    print(`\n${failures} test(s) FAILED`);
    imports.system.exit(1);
}
print('\nall tests passed');
