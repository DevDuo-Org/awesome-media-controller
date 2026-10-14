import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { resolveArtPath } from './art.js';
import { verticalBoxProps } from './compat.js';
import { EqBars } from './eq-bars.js';
import { MediaPopup } from './popup.js';

const MAX_TITLE_W = 200;

export const PanelWidget = GObject.registerClass(
class PanelWidget extends PanelMenu.Button {

    _init(watcher, theme, settings) {
        super._init(0.5, 'Awesome Media Controller', false);
        this._watcher  = watcher;
        this._theme    = theme;
        this._settings = settings;
        this._marqueeTimerId = 0;
        this._pulseTimerId = 0;
        this._currentArtUrl = '';
        this._artPath = null;
        this._popup = null;
        this._buildUI();
        this._connectSignals();
        this._applyTheme();
        this._popup = new MediaPopup(this, watcher, theme, settings);

        const position = settings.get_string('panel-position');
        const boxes = { left: 'left', center: 'center', right: 'right' };
        Main.panel.addToStatusArea('awesome-media-controller', this, 1, boxes[position] ?? 'center');
    }

    _buildUI() {
        this._pill = new St.BoxLayout({
            style_class: 'amc-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._pill);

        // Album art thumbnail (22×22 rounded square)
        this._artActor = new St.Widget({
            width: 22,
            height: 22,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pill.add_child(this._artActor);

        // Text column
        const textBox = new St.BoxLayout({
            ...verticalBoxProps(),
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin: 0 5px 0 7px;',
        });
        this._pill.add_child(textBox);

        // Fixed-width viewport: the title scrolls inside it and can never
        // grow the pill, whatever the text width is.
        this._titleClip = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'amc-title-clip',
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        textBox.add_child(this._titleClip);

        this._titleLabel = new St.Label({
            text: '...',
            style_class: 'amc-pill-title',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleClip.add_child(this._titleLabel);

        // Soft edge fades, only shown while the title is scrolling
        this._fadeL = new St.Widget({
            style_class: 'amc-fade-left', width: 14, opacity: 0,
            x_align: Clutter.ActorAlign.START, y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._fadeR = new St.Widget({
            style_class: 'amc-fade-right', width: 14, opacity: 0,
            x_align: Clutter.ActorAlign.END, y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._titleClip.add_child(this._fadeL);
        this._titleClip.add_child(this._fadeR);

        this._artistLabel = new St.Label({
            text: '',
            style_class: 'amc-pill-artist',
            y_align: Clutter.ActorAlign.CENTER,
        });
        textBox.add_child(this._artistLabel);

        this._eq = new EqBars(this._theme);
        this._eq.visible = false;
        this._pill.add_child(this._eq);

        // Control buttons
        this._ctrlBox = new St.BoxLayout({
            style: 'spacing: 2px;',
            y_align: Clutter.ActorAlign.CENTER,
            visible: this._settings.get_boolean('show-pill-controls'),
        });
        this._pill.add_child(this._ctrlBox);

        this._prevBtn = this._makeBtn('media-skip-backward-symbolic');
        this._playIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 10,
        });
        this._playBtn = new St.Button({
            style_class: 'amc-btn-accent',
            child: this._playIcon,
        });
        this._nextBtn = this._makeBtn('media-skip-forward-symbolic');

        this._ctrlBox.add_child(this._prevBtn);
        this._ctrlBox.add_child(this._playBtn);
        this._ctrlBox.add_child(this._nextBtn);

        this._prevBtn.connect('clicked', () => {
            this._watcher.previous();
            return Clutter.EVENT_STOP;
        });
        this._playBtn.connect('clicked', () => {
            this._watcher.playPause();
            return Clutter.EVENT_STOP;
        });
        this._nextBtn.connect('clicked', () => {
            this._watcher.next();
            return Clutter.EVENT_STOP;
        });
    }

    _makeBtn(iconName) {
        return new St.Button({
            style_class: 'amc-btn',
            style: 'width: 20px; height: 20px;',
            child: new St.Icon({ icon_name: iconName, icon_size: 10 }),
        });
    }

    _applyTheme() {
        const t = this._theme;
        this._pill.style = this._pillStyle(0.30);
        this._playBtn.style = [
            `background-image: ${t.gradient()}`,
            'width: 20px',
            'height: 20px',
            'margin: 0 2px',
        ].join(';');
        this._applyArtStyle();
        this._eq?.refreshColor();
    }

    // Border + outer glow; alpha varies during the playing pulse
    _pillStyle(glowAlpha) {
        const t = this._theme;
        return `border: 1px solid ${t.glow(0.35)}; box-shadow: 0 0 10px ${t.glow(glowAlpha)};`;
    }

    _applyArtStyle() {
        if (!this._artActor) return;
        const t = this._theme;
        const base = `border-radius: 5px; width: 22px; height: 22px; ` +
                     `border: 1px solid ${t.glow(0.6)}; box-shadow: 0 0 6px ${t.glow(0.4)};`;
        this._artActor.style = this._artPath
            ? `background-image: url("file://${this._artPath}"); background-size: cover; ${base}`
            : `background-image: ${t.gradient()}; ${base}`;
    }

    _connectSignals() {
        this._watcher.connectObject(
            'player-changed',       () => this._update(),
            'players-list-changed', () => this._update(),
            this
        );
        this._theme.connectObject('changed', () => this._applyTheme(), this);
        this._settings.connectObject(
            'changed::show-pill-controls', () => {
                this._ctrlBox.visible = this._settings.get_boolean('show-pill-controls');
            },
            'changed::enable-marquee', () => {
                this._stopMarquee();
                if (this.visible && !this.menu.isOpen) this._startMarquee();
            },
            'changed::enable-animations', () => this._update(),
            this
        );
        this.menu.connectObject('open-state-changed', (_menu, open) => {
            if (open) this._stopMarquee();
            else      this._startMarquee();
        }, this);
        // The actor can be destroyed from C (e.g. shell shutdown) without our
        // destroy() override running — tear down handlers either way
        this.connect('destroy', () => this._teardown());
        this._update();
    }

    _update() {
        if (!this._titleLabel) return; // already torn down
        const state = this._watcher.getPlayerState();
        if (!state || !state.title) {
            this.hide();
            this._stopMarquee();
            this._eq?.stop();
            this._stopPulse();
            return;
        }
        this.show();
        this._stopMarquee();
        const changed = this._titleLabel.text !== state.title;
        this._titleLabel.text  = state.title;
        this._artistLabel.text = state.artist;
        this._fitTitle();
        if (changed && this._settings.get_boolean('enable-animations')) this._enterAnim();
        this._playIcon.icon_name = state.playbackStatus === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._loadPillArt(state.artUrl);
        const playing = state.playbackStatus === 'Playing';
        const animate = this._settings.get_boolean('enable-animations');
        if (this._eq) {
            this._eq.visible = animate;
            if (playing && animate) this._eq.start();
            else this._eq.stop();
        }
        if (playing && animate) this._startPulse();
        else this._stopPulse();
        if (!this.menu.isOpen) this._startMarquee();
    }

    // Size the viewport to the text, capped at MAX_TITLE_W
    _fitTitle() {
        const ct = this._titleLabel.clutter_text;
        ct.ellipsize = Pango.EllipsizeMode.NONE;
        const natural = ct.get_preferred_width(-1)[1];
        this._titleNaturalW = natural;
        this._titleClip.width = Math.min(natural + 2, MAX_TITLE_W);
    }

    // Track change: title slides up and fades in
    _enterAnim() {
        const box = this._titleClip;
        box.remove_all_transitions();
        box.set({ opacity: 0, translation_y: 6 });
        box.ease({
            opacity: 255, translation_y: 0, duration: 280,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _setFades(on) {
        const o = on ? 255 : 0;
        for (const f of [this._fadeL, this._fadeR])
            f?.ease({ opacity: o, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
    }

    _startMarquee() {
        if (!this._titleLabel) return;
        if (!this._settings.get_boolean('enable-marquee')) return;
        this._stopMarquee();
        this._fitTitle();
        const overflow = this._titleNaturalW + 2 - MAX_TITLE_W;
        if (overflow <= 0) return;

        const ct = this._titleLabel;
        const END_GAP = 10;
        const PAUSE_TICKS = 45; // ~1.5s at 33ms
        const limit = overflow + END_GAP;
        let offset = 0;
        let pause = PAUSE_TICKS;
        this._setFades(true);
        this._fadeL.opacity = 0; // left fade only once scrolled

        this._marqueeTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
            if (!this._titleLabel) return GLib.SOURCE_REMOVE;
            if (pause > 0) {
                pause--;
                if (pause === 0 && offset >= limit) {
                    offset = 0;
                    ct.translation_x = 0;
                    pause = PAUSE_TICKS;
                    this._fadeL.ease({ opacity: 0, duration: 200 });
                }
                return GLib.SOURCE_CONTINUE;
            }
            offset += 1;
            if (offset === 1) this._fadeL.ease({ opacity: 255, duration: 200 });
            ct.translation_x = -offset;
            if (offset >= limit) pause = PAUSE_TICKS;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopMarquee() {
        if (this._marqueeTimerId) {
            GLib.source_remove(this._marqueeTimerId);
            this._marqueeTimerId = 0;
        }
        if (this._titleLabel) {
            this._titleLabel.translation_x = 0;
            this._fadeL?.set({ opacity: 0 });
            this._fadeR?.set({ opacity: 0 });
        }
    }

    // Slow sinusoidal breathing of the pill's outer glow while playing
    _startPulse() {
        if (this._pulseTimerId) return;
        let t = 0;
        this._pulseTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (!this._pill) {
                this._pulseTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            t += 0.25;
            this._pill.style = this._pillStyle(0.35 + 0.10 * Math.sin(t * 2.5));
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPulse() {
        if (this._pulseTimerId) {
            GLib.source_remove(this._pulseTimerId);
            this._pulseTimerId = 0;
        }
        if (this._pill) this._pill.style = this._pillStyle(0.30);
    }

    _loadPillArt(url) {
        if (url === this._currentArtUrl) return;
        this._currentArtUrl = url;
        this._artPath = null;
        this._applyArtStyle();
        if (!url) {
            this._theme.setArtPath(null);
            return;
        }
        resolveArtPath(url).then(path => {
            if (url !== this._currentArtUrl || !this._artActor) return;
            this._artPath = path;
            this._theme.setArtPath(path);
            this._applyArtStyle();
        }).catch(() => {});
    }

    _teardown() {
        this._popup?.destroy();
        this._popup = null;
        this._watcher.disconnectObject(this);
        this._theme.disconnectObject(this);
        this._settings.disconnectObject(this);
        this.menu.disconnectObject(this);
        this._stopPulse();
        this._stopMarquee();
        this._eq?.stop();
        this._titleLabel = null;
        this._titleClip = null;
        this._fadeL = null;
        this._fadeR = null;
        this._pill = null;
        this._artActor = null;
        this._eq = null;
    }

    destroy() {
        this._teardown();
        super.destroy();
    }
});
