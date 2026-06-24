import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

// Three decorative equalizer bars that bounce while music plays.
// Purely cosmetic (no audio data) — heights follow phase-shifted sines.

export const EqBars = GObject.registerClass(
class EqBars extends St.BoxLayout {

    _init(theme, { barWidth = 2, minHeight = 3, maxHeight = 11 } = {}) {
        super._init({ style: 'spacing: 2px;', y_align: Clutter.ActorAlign.CENTER });
        this._theme   = theme;
        this._min     = minHeight;
        this._max     = maxHeight;
        this._timerId = 0;
        this._phase   = 0;

        this._bars = [0, 1, 2].map(() => {
            const bar = new St.Widget({
                width: barWidth,
                height: minHeight,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this.add_child(bar);
            return bar;
        });
        this.refreshColor();
    }

    refreshColor() {
        for (const bar of this._bars)
            bar.style = `background-color: ${this._theme.accentA}; border-radius: 99px;`;
    }

    start() {
        if (this._timerId) return;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._phase++;
            this._bars.forEach((bar, i) => {
                const t = this._phase * 0.9 + i * 2.1;
                const f = (Math.sin(t) + Math.sin(t * 1.7 + i)) / 4 + 0.5; // ~0..1
                bar.height = Math.round(this._min + f * (this._max - this._min));
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    /** Stop animating and freeze bars at resting height */
    stop() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        for (const bar of this._bars) bar.height = this._min;
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        super.destroy();
    }
});
