import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import { warn } from './log.js';

const MPRIS_PLAYER_IFACE = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg type="x" direction="in" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="LoopStatus"     type="s" access="readwrite"/>
    <property name="Shuffle"        type="b" access="readwrite"/>
    <property name="Metadata"       type="a{sv}" access="read"/>
    <property name="Volume"         type="d" access="readwrite"/>
    <property name="Position"       type="x" access="read"/>
    <property name="CanGoNext"      type="b" access="read"/>
    <property name="CanGoPrevious"  type="b" access="read"/>
    <property name="CanPlay"        type="b" access="read"/>
    <property name="CanPause"       type="b" access="read"/>
    <property name="CanSeek"        type="b" access="read"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(MPRIS_PLAYER_IFACE);

// "org.mpris.MediaPlayer2.chromium.instance1234" → "Chromium"
export function prettyBusName(busName) {
    const name = busName
        .replace('org.mpris.MediaPlayer2.', '')
        .replace(/\.instance[-_]?\d+$/, '');
    return name.charAt(0).toUpperCase() + name.slice(1);
}

export const MprisWatcher = GObject.registerClass({
    Signals: {
        'player-changed':      {},
        'players-list-changed': {},
    },
}, class MprisWatcher extends GObject.Object {

    _init() {
        super._init();
        this._players = new Map(); // busName → { proxy, lastChanged, identity }
        this._pendingPlayers = new Set(); // busNames currently being added (TOCTOU guard)
        this._activePlayerName = null;
        this._nameWatchId = 0;
        this._cancellable = new Gio.Cancellable();
        this._initAsync();
    }

    async _initAsync() {
        // Subscribe before listing names so no NameOwnerChanged is missed during enumeration
        this._nameWatchId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            this._onNameOwnerChanged.bind(this)
        );

        try {
            const result = await Gio.DBus.session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null,
                new GLib.VariantType('(as)'),
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );
            const [names] = result.deepUnpack();
            for (const name of names) {
                if (this._cancellable.is_cancelled()) return;
                if (name.startsWith('org.mpris.MediaPlayer2.'))
                    await this._addPlayer(name);
            }
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                warn('AMC: ListNames failed:', e.message);
        }
    }

    _onNameOwnerChanged(_conn, _sender, _path, _iface, _signal, params) {
        const [name, oldOwner, newOwner] = params.deepUnpack();
        if (!name.startsWith('org.mpris.MediaPlayer2.')) return;

        if (oldOwner)
            this._removePlayer(name);
        if (newOwner)
            this._addPlayer(name);
    }

    async _addPlayer(busName) {
        if (this._players.has(busName) || this._pendingPlayers.has(busName)) return;
        this._pendingPlayers.add(busName);
        try {
            const proxy = await new Promise((resolve, reject) => {
                new PlayerProxy(
                    Gio.DBus.session,
                    busName,
                    '/org/mpris/MediaPlayer2',
                    (p, err) => err ? reject(err) : resolve(p),
                    this._cancellable
                );
            });

            this._pendingPlayers.delete(busName);

            if (this._cancellable.is_cancelled() || this._players.has(busName)) return;

            const entry = { proxy, lastChanged: Date.now(), identity: '' };
            this._players.set(busName, entry);
            this._fetchIdentity(busName, entry);

            proxy.connectObject('g-properties-changed', (p, changed, invalidated) => {
                if (!this._players.has(busName)) return;
                entry.lastChanged = Date.now();

                const properties = changed.deepUnpack();
                if (properties['PlaybackStatus'] || properties['Metadata']) {
                    this._activePlayerName = this._pickBestPlayer();
                    this.emit('player-changed');
                }
            }, this);

            this._activePlayerName = this._pickBestPlayer();
            this.emit('players-list-changed');
            this.emit('player-changed');
        } catch (e) {
            this._pendingPlayers.delete(busName);
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                warn(`AMC: proxy failed for ${busName}:`, e.message);
        }
    }

    async _fetchIdentity(busName, entry) {
        // Identity lives on the root org.mpris.MediaPlayer2 interface,
        // not the Player interface our proxy wraps
        try {
            const reply = await Gio.DBus.session.call(
                busName,
                '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2', 'Identity']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );
            if (!this._players.has(busName)) return;
            entry.identity = reply.deepUnpack()[0].deepUnpack();
            this.emit('players-list-changed');
        } catch (_e) { /* fall back to bus-name-derived label */ }
    }

    // Players never emit PropertiesChanged for Position (MPRIS spec uses the
    // Seeked signal instead), so the proxy cache is stale — ask fresh.
    async fetchPosition() {
        if (!this._activePlayerName) return 0;
        try {
            const reply = await Gio.DBus.session.call(
                this._activePlayerName,
                '/org/mpris/MediaPlayer2',
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE,
                -1,
                this._cancellable
            );
            return reply.deepUnpack()[0].deepUnpack();
        } catch (_e) {
            return this.activeProxy?.Position ?? 0;
        }
    }

    _removePlayer(busName) {
        const entry = this._players.get(busName);
        if (!entry) return;
        entry.proxy.disconnectObject(this);
        this._players.delete(busName);
        if (this._activePlayerName === busName)
            this._activePlayerName = this._pickBestPlayer();
        this.emit('players-list-changed');
        this.emit('player-changed');
    }

    _pickBestPlayer() {
        let best = null, bestTime = -1;
        for (const [name, entry] of this._players) {
            if (entry.proxy.PlaybackStatus === 'Playing') return name;
            if (entry.lastChanged > bestTime) { bestTime = entry.lastChanged; best = name; }
        }
        return best;
    }

    // ── Read API ──────────────────────────────────────────────────────────

    get activeProxy() {
        return this._players.get(this._activePlayerName)?.proxy ?? null;
    }

    getPlayerState() {
        const proxy = this.activeProxy;
        if (!proxy) return null;

        // recursiveUnpack fully unwraps the a{sv} variant; the proxy getter's
        // own deepUnpack only goes one level, leaving Variant values inside
        const meta = proxy.get_cached_property('Metadata')?.recursiveUnpack() ?? {};
        const artistRaw = meta['xesam:artist'] ?? [];

        return {
            title:          meta['xesam:title']  ?? '',
            artist:         Array.isArray(artistRaw) ? artistRaw.join(', ') : String(artistRaw),
            album:          meta['xesam:album']  ?? '',
            artUrl:         meta['mpris:artUrl'] ?? '',
            length:         meta['mpris:length'] ?? 0,
            playbackStatus: proxy.PlaybackStatus ?? 'Stopped',
            shuffle:        proxy.Shuffle        ?? false,
            loopStatus:     proxy.LoopStatus     ?? 'None',
            volume:         proxy.Volume         ?? 1.0,
            position:       proxy.Position       ?? 0,
            trackId:        meta['mpris:trackid'] ?? '/org/mpris/MediaPlayer2/TrackList/NoTrack',
            playerName:     this._activePlayerName ?? '',
        };
    }

    getPlayerList() {
        return [...this._players.entries()].map(([busName, entry]) => ({
            busName,
            displayName: entry.identity || prettyBusName(busName),
            isActive:    busName === this._activePlayerName,
            isPlaying:   entry.proxy.PlaybackStatus === 'Playing',
        }));
    }

    // ── Command API ───────────────────────────────────────────────────────

    playPause()  { this.activeProxy?.PlayPauseAsync().catch(e => warn('AMC:', e.message)); }
    next()       { this.activeProxy?.NextAsync().catch(e => warn('AMC:', e.message)); }
    previous()   { this.activeProxy?.PreviousAsync().catch(e => warn('AMC:', e.message)); }

    seekTo(positionMicroseconds) {
        const state = this.getPlayerState();
        if (!state) return;
        this.activeProxy?.SetPositionAsync(state.trackId, positionMicroseconds)
            .catch(e => warn('AMC seekTo:', e.message));
    }

    setVolume(vol) {
        if (!this.activeProxy) return;
        this.activeProxy.Volume = Math.max(0.0, Math.min(1.0, vol));
    }

    setShuffle(val) {
        if (!this.activeProxy) return;
        this.activeProxy.Shuffle = val;
    }

    setLoopStatus(val) {
        if (!this.activeProxy) return;
        this.activeProxy.LoopStatus = val;
    }

    setActive(busName) {
        if (!this._players.has(busName)) return;
        this._activePlayerName = busName;
        this.emit('player-changed');
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    destroy() {
        this._cancellable.cancel();
        if (this._nameWatchId) {
            Gio.DBus.session.signal_unsubscribe(this._nameWatchId);
            this._nameWatchId = 0;
        }
        for (const entry of this._players.values())
            entry.proxy.disconnectObject(this);
        this._players.clear();
        this._pendingPlayers.clear();
        this._activePlayerName = null;
    }
});
