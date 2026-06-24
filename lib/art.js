import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

let _session = null;
function getSession() {
    if (!_session) _session = new Soup.Session();
    return _session;
}

const _inFlight = new Map(); // url → Promise<path|null>

/**
 * Abort any in-flight art downloads and drop the shared session. Called from
 * the extension's disable() so no network work outlives the extension.
 */
export function abortArtRequests() {
    if (_session) {
        _session.abort();
        _session = null;
    }
    _inFlight.clear();
}

/**
 * Resolve an MPRIS artUrl to a local file path, downloading https art
 * into a /tmp cache. Returns null when unavailable.
 */
export function resolveArtPath(url) {
    if (!url) return Promise.resolve(null);

    if (url.startsWith('file://')) {
        try {
            const path = GLib.filename_from_uri(url)[0];
            return Promise.resolve(GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null);
        } catch (_e) {
            return Promise.resolve(null);
        }
    }

    const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, url, -1);
    const cachePath = `${GLib.get_tmp_dir()}/amc-art-${hash}`;
    if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) return Promise.resolve(cachePath);

    if (_inFlight.has(url)) return _inFlight.get(url);

    const promise = (async () => {
        try {
            const msg   = Soup.Message.new('GET', url);
            const bytes = await getSession().send_and_read_async(msg, GLib.PRIORITY_LOW, null);
            if (msg.get_status() !== Soup.Status.OK) return null;
            const file = Gio.File.new_for_path(cachePath);
            await file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            return cachePath;
        } catch (e) {
            console.warn('AMC art load failed:', e.message);
            return null;
        } finally {
            _inFlight.delete(url);
        }
    })();
    _inFlight.set(url, promise);
    return promise;
}
