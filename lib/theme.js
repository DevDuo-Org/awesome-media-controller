import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import GdkPixbuf from 'gi://GdkPixbuf';

// ── Pure color math (kept side-effect free so it can run under plain gjs) ──

export function rgbToHex({ r, g, b }) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return `#${c(r)}${c(g)}${c(b)}`;
}

export function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r)      h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else                h = (r - g) / d + 4;
        h = (h * 60 + 360) % 360;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
}

/**
 * Extract two accent colors from raw pixbuf data.
 * Buckets colorful pixels by hue, picks the most vibrant bucket as the
 * primary accent and the strongest hue-distant bucket as the secondary.
 * Returns null when the image is essentially monochrome.
 */
export function extractPalette(pixels, nChannels, rowstride, width, height) {
    const BINS = 12;
    const bins = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * rowstride + x * nChannels;
            const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
            if (nChannels === 4 && pixels[i + 3] < 128) continue;
            const { h, s, v } = rgbToHsv(r, g, b);
            if (s < 0.18 || v < 0.18) continue; // skip grays and near-black
            const w = s * v;
            const bin = bins[Math.floor(h / (360 / BINS)) % BINS];
            bin.w += w;
            bin.r += r * w; bin.g += g * w; bin.b += b * w;
        }
    }

    const ranked = bins
        .map((bin, idx) => ({ ...bin, idx }))
        .filter((bin) => bin.w > 0)
        .sort((a, b) => b.w - a.w);
    if (ranked.length === 0) return null;

    const avg = (bin) => boostColor({ r: bin.r / bin.w, g: bin.g / bin.w, b: bin.b / bin.w });
    const primary = ranked[0];

    // Secondary: strongest bucket at least 2 hue bins away, else shift primary
    const hueDist = (a, b) => Math.min(Math.abs(a - b), BINS - Math.abs(a - b));
    const secondary = ranked.find((bin) => hueDist(bin.idx, primary.idx) >= 2);

    const c1 = avg(primary);
    const c2 = secondary ? avg(secondary) : shiftColor(c1);
    return [rgbToHex(c1), rgbToHex(c2)];
}

// Lift dark muddy averages toward something visible on the dark glass card
function boostColor({ r, g, b }) {
    const max = Math.max(r, g, b, 1);
    if (max < 140) {
        const k = 140 / max;
        return { r: r * k, g: g * k, b: b * k };
    }
    return { r, g, b };
}

// Fallback secondary when the art is single-hued: rotate channels slightly
function shiftColor({ r, g, b }) {
    return { r: (r + 80) % 256 * 0.7 + 60, g: g * 0.55 + 30, b: (b + 120) % 256 * 0.7 + 60 };
}

export function extractPaletteFromFile(path) {
    const pix = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, 32, 32, true);
    return extractPalette(
        pix.get_pixels(),
        pix.get_n_channels(),
        pix.get_rowstride(),
        pix.get_width(),
        pix.get_height()
    );
}

// ── Built-in theme presets ─────────────────────────────────────────────────
// Single source of truth: prefs.js reads labels from here too.

export const PRESETS = {
    'synthwave':   { label: 'Synthwave',    colors: ['#ff2d95', '#7b2dff'] },
    'cyberpunk':   { label: 'Cyberpunk',    colors: ['#00e5ff', '#ff00aa'] },
    'aurora':      { label: 'Aurora',       colors: ['#2dd4bf', '#8b5cf6'] },
    'sunset-lofi': { label: 'Sunset Lo-fi', colors: ['#ff7e5f', '#feb47b'] },
    'toxic':       { label: 'Toxic',        colors: ['#a3ff12', '#00ffd5'] },
    'crimson':     { label: 'Crimson',      colors: ['#ff3b3b', '#ff9d00'] },
};

/** Colors for a preset name, falling back to synthwave for unknown names */
export function resolvePreset(name) {
    return (PRESETS[name] ?? PRESETS['synthwave']).colors;
}

// ── ThemeManager ───────────────────────────────────────────────────────────
//
// Single source of truth for accent colors. In 'adaptive' mode the accents
// follow the current album art; in 'preset' mode they come from a built-in
// PRESETS entry; in 'custom' mode they come from settings.

export const ThemeManager = GObject.registerClass({
    Signals: { 'changed': {} },
}, class ThemeManager extends GObject.Object {

    _init(settings) {
        super._init();
        this._settings = settings;
        this._artColors = null;
        this._artPath = null;
        this._cache = new Map(); // art path → [hex, hex] | null
        for (const key of ['accent-mode', 'accent-start', 'accent-end', 'theme-preset'])
            settings.connectObject(`changed::${key}`, () => this.emit('changed'), this);
    }

    _resolveColors() {
        const mode = this._settings.get_string('accent-mode');
        if (mode === 'adaptive' && this._artColors) return this._artColors;
        if (mode === 'preset') return resolvePreset(this._settings.get_string('theme-preset'));
        return [this._settings.get_string('accent-start'), this._settings.get_string('accent-end')];
    }

    get accentA() { return this._resolveColors()[0]; }

    get accentB() { return this._resolveColors()[1]; }

    get _adaptive() {
        return this._settings.get_string('accent-mode') === 'adaptive';
    }

    gradient(deg = 135) {
        return `linear-gradient(${deg}deg, ${this.accentA}, ${this.accentB})`;
    }

    /** rgba() string of accentA with given alpha — for borders/glows */
    glow(alpha) {
        const hex = this.accentA;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    setArtPath(path) {
        if (path === this._artPath) return;
        this._artPath = path;
        if (!path) {
            this._setArtColors(null);
            return;
        }
        if (this._cache.has(path)) {
            this._setArtColors(this._cache.get(path));
            return;
        }
        // Decode off the paint path; a 32px scale-down of cached art is cheap
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (this._artPath !== path || !this._settings) return GLib.SOURCE_REMOVE;
            let colors = null;
            try {
                colors = extractPaletteFromFile(path);
            } catch (e) {
                console.warn('AMC: palette extraction failed:', e.message);
            }
            if (this._cache.size > 40) this._cache.clear();
            this._cache.set(path, colors);
            if (this._artPath === path) this._setArtColors(colors);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setArtColors(colors) {
        this._artColors = colors;
        if (this._adaptive) this.emit('changed');
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._settings = null;
        this._cache.clear();
    }
});
