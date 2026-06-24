import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { resolveArtPath } from './art.js';
import { verticalBoxProps } from './compat.js';
import { EqBars } from './eq-bars.js';

// ── helpers ────────────────────────────────────────────────────────────────

export function formatTime(microseconds) {
    const s = Math.floor(Math.max(0, microseconds) / 1_000_000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const POSITION_RESYNC_TICKS = 5; // re-ask the player for Position every N seconds

// ── MediaPopup ─────────────────────────────────────────────────────────────

export const MediaPopup = GObject.registerClass(
class MediaPopup extends GObject.Object {

    _init(panelButton, watcher, theme, settings) {
        super._init();
        this._btn      = panelButton;
        this._watcher  = watcher;
        this._theme    = theme;
        this._settings = settings;
        this._posTimerId        = 0;
        this._position          = 0;
        this._length            = 0;
        this._ticks             = 0;
        this._scrubbing         = false;
        this._currentArtUrl     = '';
        this._artPath           = null;
        this._buildMenu();
        this._connectSignals();
        this._applyTheme();
    }

    _buildMenu() {
        const menu = this._btn.menu;

        this._menuBox = menu.box;

        // Single PopupBaseMenuItem containing our card
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: '',
        });
        item.remove_all_children();
        item.set_style('padding: 0; margin: 0; border: none;');

        this._card = this._buildCard();
        item.add_child(this._card);
        menu.addMenuItem(item);

        menu.connectObject('open-state-changed', (_menu, open) => {
            if (open) {
                this._updateAll();
                this._syncPosition();
                this._startPositionTimer();
                if (this._settings.get_boolean('enable-animations')) {
                    this._card.opacity = 0;
                    this._card.set_pivot_point(0.5, 0.5);
                    this._card.set_scale(0.96, 0.96);
                    this._card.ease({
                        opacity: 255,
                        scale_x: 1,
                        scale_y: 1,
                        duration: 180,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    });
                }
            } else {
                this._stopPositionTimer();
                this._eq?.stop();
            }
        }, this);
    }

    _buildCard() {
        const card = new St.BoxLayout({
            ...verticalBoxProps(),
            style: 'padding: 16px 16px 14px 16px; width: 280px;',
        });

        // ── Album art ─────────────────────────────────────────────────────
        this._artWidget = new St.Widget({ height: 248 });
        card.add_child(this._artWidget);

        // ── Track info ────────────────────────────────────────────────────
        const titleRow = new St.BoxLayout({ style: 'spacing: 8px;' });
        this._popupTitle = new St.Label({
            text: '',
            style_class: 'amc-popup-title',
            x_expand: true,
        });
        this._popupTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleRow.add_child(this._popupTitle);
        this._eq = new EqBars(this._theme, { minHeight: 4, maxHeight: 12 });
        this._eq.visible = false;
        titleRow.add_child(this._eq);
        card.add_child(titleRow);

        this._popupArtist = new St.Label({ text: '', style_class: 'amc-popup-artist' });
        card.add_child(this._popupArtist);

        this._popupAlbum = new St.Label({ text: '', style_class: 'amc-popup-album' });
        card.add_child(this._popupAlbum);

        // ── Progress bar (click or drag to seek) ──────────────────────────
        [this._progressContainer, this._progressFill, this._progressKnob] = this._buildSlider(
            (fraction) => { // live preview while dragging
                this._scrubbing = true;
                this._position = fraction * this._length;
                this._updateProgress();
            },
            (fraction) => { // commit on release
                this._scrubbing = false;
                if (this._length > 0)
                    this._watcher.seekTo(Math.floor(fraction * this._length));
            },
            true
        );
        this._progressContainer.style = 'margin-bottom: 4px;';
        card.add_child(this._progressContainer);

        // Time labels
        const timeRow = new St.BoxLayout({ style: 'margin-bottom: 10px;' });
        this._elapsedLabel = new St.Label({
            text: '0:00',
            style_class: 'amc-time-label',
            x_expand: true,
        });
        this._totalLabel = new St.Label({ text: '0:00', style_class: 'amc-time-label' });
        timeRow.add_child(this._elapsedLabel);
        timeRow.add_child(this._totalLabel);
        card.add_child(timeRow);

        // ── Controls row ──────────────────────────────────────────────────
        const ctrlRow = new St.BoxLayout({
            style: 'spacing: 8px; margin-bottom: 12px;',
            x_align: Clutter.ActorAlign.CENTER,
        });
        card.add_child(ctrlRow);

        this._shuffleBtn = this._makePopupBtn('media-playlist-shuffle-symbolic', 28);
        this._prevBtn2   = this._makePopupBtn('media-skip-backward-symbolic', 34);
        this._playIcon2  = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 20,
        });
        this._playBtn2   = new St.Button({
            style_class: 'amc-btn-accent',
            child: this._playIcon2,
        });
        this._addPressFeedback(this._playBtn2);
        this._nextBtn2   = this._makePopupBtn('media-skip-forward-symbolic', 34);
        this._repeatBtn  = this._makePopupBtn('media-playlist-repeat-symbolic', 28);

        ctrlRow.add_child(this._shuffleBtn);
        ctrlRow.add_child(this._prevBtn2);
        ctrlRow.add_child(this._playBtn2);
        ctrlRow.add_child(this._nextBtn2);
        ctrlRow.add_child(this._repeatBtn);

        this._shuffleBtn.connect('clicked', () => {
            const state = this._watcher.getPlayerState();
            if (state) this._watcher.setShuffle(!state.shuffle);
        });
        this._prevBtn2.connect('clicked',  () => this._watcher.previous());
        this._playBtn2.connect('clicked',  () => this._watcher.playPause());
        this._nextBtn2.connect('clicked',  () => this._watcher.next());
        this._repeatBtn.connect('clicked', () => {
            const state = this._watcher.getPlayerState();
            if (!state) return;
            const next = { None: 'Track', Track: 'Playlist', Playlist: 'None' }[state.loopStatus] ?? 'None';
            this._watcher.setLoopStatus(next);
        });

        // ── Volume row (click or drag) ────────────────────────────────────
        const volRow = new St.BoxLayout({
            style: 'spacing: 8px; margin-bottom: 12px;',
            y_align: Clutter.ActorAlign.CENTER,
        });
        card.add_child(volRow);

        volRow.add_child(new St.Icon({
            icon_name: 'audio-volume-low-symbolic',
            icon_size: 12,
            style: 'color: rgba(255,255,255,0.35);',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        [this._volContainer, this._volFill] = this._buildSlider(
            (fraction) => {
                this._watcher.setVolume(fraction);
                this._updateVolBar(fraction);
            },
            () => {}
        );
        volRow.add_child(this._volContainer);

        volRow.add_child(new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            icon_size: 12,
            style: 'color: rgba(255,255,255,0.35);',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // ── Separator ─────────────────────────────────────────────────────
        card.add_child(new St.Widget({
            height: 1,
            x_expand: true,
            style: 'background-color: rgba(255,255,255,0.07); margin-bottom: 12px;',
        }));

        // ── Player switcher ───────────────────────────────────────────────
        this._switcherLabel = new St.Label({
            text: 'ACTIVE PLAYERS',
            style_class: 'amc-switcher-label',
        });
        card.add_child(this._switcherLabel);

        this._switcherRow = new St.BoxLayout({ style: 'spacing: 6px;' });
        card.add_child(this._switcherRow);

        return card;
    }

    // A 16px-tall reactive track with a fill bar. onChange fires on press and
    // while dragging with button held; onCommit fires on release.
    _buildSlider(onChange, onCommit, withKnob = false) {
        const container = new St.Widget({
            height: 16,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: true,
        });
        const track = new St.Widget({
            height: 4,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'background-color: rgba(255,255,255,0.1); border-radius: 99px;',
        });
        const fill = new St.Widget({
            height: 4,
            width: 0,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        container.add_child(track);
        container.add_child(fill);

        let knob = null;
        if (withKnob) {
            knob = new St.Widget({
                width: 10,
                height: 10,
                x_align: Clutter.ActorAlign.START,
                y_align: Clutter.ActorAlign.CENTER,
            });
            container.add_child(knob);
        }

        const fractionAt = (event) => {
            const [x] = event.get_coords();
            const [ax] = container.get_transformed_position();
            const w = container.width;
            return w > 0 ? Math.max(0, Math.min(1, (x - ax) / w)) : 0;
        };

        let pressed = false;
        container.connect('button-press-event', (_a, event) => {
            pressed = true;
            onChange(fractionAt(event));
            return Clutter.EVENT_STOP;
        });
        container.connect('motion-event', (_a, event) => {
            if (!pressed) return Clutter.EVENT_PROPAGATE;
            onChange(fractionAt(event));
            return Clutter.EVENT_STOP;
        });
        container.connect('button-release-event', (_a, event) => {
            if (!pressed) return Clutter.EVENT_PROPAGATE;
            pressed = false;
            onCommit(fractionAt(event));
            return Clutter.EVENT_STOP;
        });
        container.connect('leave-event', () => {
            if (pressed) {
                pressed = false;
                onCommit(fill.width / Math.max(1, container.width));
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return [container, fill, knob];
    }

    _makePopupBtn(iconName, size) {
        const btn = new St.Button({
            style_class: 'amc-btn',
            style: `width: ${size}px; height: ${size}px;`,
            child: new St.Icon({ icon_name: iconName, icon_size: Math.floor(size * 0.45) }),
        });
        this._addPressFeedback(btn);
        return btn;
    }

    // Tactile press: scale down while pressed, spring back on release
    _addPressFeedback(btn) {
        btn.set_pivot_point(0.5, 0.5);
        btn.connect('notify::pressed', () => {
            if (!this._settings.get_boolean('enable-animations')) return;
            const s = btn.pressed ? 0.92 : 1.0;
            btn.ease({
                scale_x: s,
                scale_y: s,
                duration: 100,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    // ── Theme ──────────────────────────────────────────────────────────────

    _applyTheme() {
        const t = this._theme;
        this._menuBox.set_style([
            'background-color: rgba(10, 7, 20, 0.92)',
            'background-image: linear-gradient(160deg, rgba(255,255,255,0.07), rgba(255,255,255,0.0))',
            'border: 1px solid rgba(255, 255, 255, 0.09)',
            `box-shadow: 0 0 24px ${t.glow(0.30)}`,
            'border-radius: 24px',
            'padding: 0',
            'min-width: 0',
        ].join(';'));

        this._popupArtist.style = `color: ${t.accentA};`;

        this._applyPlayBtnStyle();

        const fillStyle = `background-image: ${t.gradient(90)}; border-radius: 99px; ` +
                          `box-shadow: 0 0 6px ${t.glow(0.5)};`;
        this._progressFill.style = fillStyle;
        this._volFill.style = fillStyle;
        this._progressKnob.style =
            `background-color: #ffffff; border-radius: 99px; box-shadow: 0 0 6px ${t.glow(0.8)};`;

        this._eq?.refreshColor();
        this._applyArtStyle();
        if (this._btn.menu.isOpen) this._updateAll();
    }

    _applyPlayBtnStyle() {
        const playing = this._watcher.getPlayerState()?.playbackStatus === 'Playing';
        const t = this._theme;
        this._playBtn2.style = [
            `background-image: ${t.gradient()}`,
            'width: 48px',
            'height: 48px',
            `box-shadow: 0 0 ${playing ? 16 : 8}px ${t.glow(playing ? 0.55 : 0.30)}`,
        ].join(';');
    }

    _applyArtStyle() {
        const base = 'border-radius: 16px; margin-bottom: 14px; ' +
                     `box-shadow: 0 6px 28px ${this._theme.glow(0.45)};`;
        this._artWidget.style = this._artPath
            ? `background-image: url("file://${this._artPath}"); background-size: cover; ${base}`
            : `background-image: ${this._theme.gradient()}; ${base}`;
    }

    // ── Updates ────────────────────────────────────────────────────────────

    _updateAll() {
        if (!this._artWidget) return; // already destroyed
        const state = this._watcher.getPlayerState();
        if (!state) return;

        this._popupTitle.text  = state.title;
        this._popupArtist.text = state.artist;
        this._popupAlbum.text  = state.album;

        this._length = state.length;
        this._updateProgress();

        this._playIcon2.icon_name = state.playbackStatus === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._applyPlayBtnStyle();
        this._shuffleBtn.style = this._toggleBtnStyle(state.shuffle, 28);
        this._repeatBtn.style  = this._toggleBtnStyle(state.loopStatus !== 'None', 28);

        this._updateVolBar(state.volume);
        this._updateSwitcher();
        this._loadArt(state.artUrl);

        const animate = this._settings.get_boolean('enable-animations');
        this._eq.visible = animate;
        if (animate && state.playbackStatus === 'Playing' && this._btn.menu.isOpen)
            this._eq.start();
        else
            this._eq.stop();
    }

    _syncPosition() {
        this._watcher.fetchPosition().then((position) => {
            if (this._scrubbing || !this._elapsedLabel) return;
            this._position = position;
            this._updateProgress();
        }).catch(() => {});
    }

    _updateProgress() {
        this._elapsedLabel.text = formatTime(this._position);
        this._totalLabel.text   = formatTime(this._length);
        const w = this._progressContainer.width;
        let fillW = 0;
        if (w > 0 && this._length > 0) {
            const fraction = Math.max(0, Math.min(1, this._position / this._length));
            fillW = Math.floor(w * fraction);
        }
        this._progressFill.width = fillW;
        const size = this._scrubbing ? 12 : 10; // knob grows while scrubbing
        this._progressKnob.set_size(size, size);
        this._progressKnob.translation_x = Math.max(0, fillW - Math.floor(size / 2));
    }

    _updateVolBar(vol) {
        const w = this._volContainer.width;
        if (w > 0) this._volFill.width = Math.floor(w * Math.max(0, Math.min(1, vol)));
    }

    _toggleBtnStyle(active, size) {
        const dims = `width: ${size}px; height: ${size}px;`;
        return active
            ? `background-color: ${this._theme.glow(0.3)}; color: ${this._theme.accentA}; ${dims}`
            : dims;
    }

    _updateSwitcher() {
        this._switcherRow.destroy_all_children();
        const players = this._watcher.getPlayerList();
        for (const player of players) {
            const pill = this._makePlayerPill(player);
            this._switcherRow.add_child(pill);
        }
        // Hide label + row when only one player
        const visible = players.length > 1;
        this._switcherLabel.visible = visible;
        this._switcherRow.visible   = visible;
    }

    _makePlayerPill(player) {
        const dotColor = this._playerColor(player.displayName);
        const dot = new St.Widget({
            width: 6, height: 6,
            style: `background-color: ${dotColor}; border-radius: 99px;`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const label = new St.Label({
            text: player.displayName,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const row = new St.BoxLayout({
            style_class: 'amc-player-pill',
            style: 'spacing: 5px;',
            reactive: true,
        });
        row.add_child(dot);
        row.add_child(label);

        if (player.isActive) {
            row.style = [
                `background-color: ${this._theme.glow(0.2)}`,
                `border: 1px solid ${this._theme.glow(0.4)}`,
                'spacing: 5px',
            ].join(';');
            row.reactive = false;
            label.style = `font-size: 10px; font-weight: bold; color: ${this._theme.accentA};`;
        } else {
            row.style = [
                'background-color: rgba(255,255,255,0.05)',
                'border: 1px solid rgba(255,255,255,0.08)',
                'spacing: 5px',
            ].join(';');
            label.style = 'font-size: 10px; font-weight: bold; color: rgba(255,255,255,0.4);';
            row.connect('button-press-event', () => {
                this._watcher.setActive(player.busName);
                return Clutter.EVENT_STOP;
            });
        }
        return row;
    }

    _playerColor(name) {
        const n = name.toLowerCase();
        if (n.includes('spotify')) return '#1db954';
        if (n.includes('firefox') || n.includes('chromium') || n.includes('chrome')) return '#ff7139';
        if (n.includes('vlc'))     return '#ff8800';
        if (n.includes('rhythmbox') || n.includes('clementine')) return '#e87722';
        return this._theme.accentA;
    }

    _loadArt(url) {
        if (url === this._currentArtUrl) return;
        this._currentArtUrl = url;
        this._artPath = null;
        this._applyArtStyle();
        if (!url) return;

        resolveArtPath(url).then(path => {
            if (path && url === this._currentArtUrl && this._artWidget) {
                this._artPath = path;
                this._applyArtStyle();
            }
        }).catch(() => {});
    }

    // ── Position timer ─────────────────────────────────────────────────────

    _startPositionTimer() {
        this._stopPositionTimer();
        this._ticks = 0;
        this._posTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            const state = this._watcher.getPlayerState();
            if (state?.playbackStatus === 'Playing' && !this._scrubbing) {
                this._ticks++;
                if (this._ticks % POSITION_RESYNC_TICKS === 0) {
                    this._syncPosition();
                } else {
                    this._position += 1_000_000; // +1 second
                    if (this._length > 0)
                        this._position = Math.min(this._position, this._length);
                    this._updateProgress();
                }
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPositionTimer() {
        if (this._posTimerId) {
            GLib.source_remove(this._posTimerId);
            this._posTimerId = 0;
        }
    }

    // ── Signal wiring ──────────────────────────────────────────────────────

    _connectSignals() {
        this._watcher.connectObject(
            'player-changed', () => {
                if (this._btn.menu.isOpen) {
                    this._updateAll();
                    this._syncPosition();
                }
            },
            'players-list-changed', () => {
                if (this._btn.menu.isOpen) this._updateSwitcher();
            },
            this
        );
        this._theme.connectObject('changed', () => this._applyTheme(), this);
    }

    destroy() {
        this._stopPositionTimer();
        this._btn.menu.disconnectObject(this);
        this._watcher.disconnectObject(this);
        this._theme.disconnectObject(this);
        this._eq?.stop();
        this._artWidget = null;
        this._elapsedLabel = null;
        this._eq = null;
    }
});
