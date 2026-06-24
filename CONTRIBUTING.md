# Contributing to Awesome Media Controller

Thanks for your interest! Bug reports, version-compatibility fixes, and new preset themes are all welcome.

## Project layout

```
extension.js          Entry point (enable/disable lifecycle)
prefs.js              Adw/Gtk4 preferences UI
metadata.json         UUID, supported shell-version, schema name
stylesheet.css        Static structure; themed colors applied inline at runtime
schemas/              GSettings schema (compiled by install.sh)
lib/
  mpris.js            MPRIS2 D-Bus watcher
  theme.js            ThemeManager + palette extraction + PRESETS map
  panel-widget.js     The top-bar glass pill
  popup.js            The full glass popup card
  eq-bars.js          Shared animated EQ bars component
  art.js              Album-art path resolution
  compat.js           Cross-version St helpers
tests/
  test-theme.js       Plain-gjs unit tests (theme/palette logic)
  mock-player.js      A fake MPRIS player for integration testing
```

## Development setup

Requires GNOME Shell 50 and `gjs`.

```bash
# 1. Run unit tests
gjs -m tests/test-theme.js

# 2. Validate the settings schema
glib-compile-schemas --strict --dry-run schemas/

# 3. Deploy locally
./install.sh
```

> ⚠️ **A live Wayland session caches extension modules.** Editing files does **not** hot-reload — you must log out/in to see changes in your real session. Never "verify" a change just by looking at your running desktop right after editing.

### Integration testing without logging out

Use a headless shell with the mock player (St components only load inside a shell):

```bash
dbus-run-session -- bash -c '
  gnome-shell --headless --virtual-monitor 800x600 &> /tmp/amc-shell.log &
  SHELL_PID=$!
  sleep 6
  gjs -m tests/mock-player.js &> /tmp/amc-mock.log &
  sleep 2
  gnome-extensions enable awesome-media-controller@devduo-org
  sleep 4
  gnome-extensions info awesome-media-controller@devduo-org
  kill $SHELL_PID
'
grep -iE "JS ERROR|Gjs-CRITICAL" /tmp/amc-shell.log || echo "CLEAN: no JS errors"
```

Expect `State: ACTIVE` and no JS errors mentioning `amc`, `eq-bars`, `popup.js`, `panel-widget.js`, or `theme.js`.

## Coding guidelines

- **Match the surrounding style** — naming, comment density, and idioms already in the file.
- **Tear down everything.** Any `GLib.timeout_add` / signal `connect` must be removed/disconnected in `destroy()`/`_teardown()`. Guard timer callbacks against post-teardown calls (return `GLib.SOURCE_REMOVE` and null the id). This is the #1 thing extensions.gnome.org reviewers check.
- **No real blur.** GNOME Shell can't composite blur for extensions — the "glass" is layered `background-image` gradients + `box-shadow`. Keep it that way.
- **Themed colors stay inline.** `stylesheet.css` holds static structure only; the `ThemeManager` applies gradients/glows/borders at runtime.
- **Keep behavior (MPRIS/seek/volume) and visuals separated.**

## Adding a preset theme

Add an entry to `PRESETS` in `lib/theme.js` (label + two lowercase hex colors). The prefs dropdown and the unit tests read from this single source automatically — then update the count assertion in `tests/test-theme.js`.

## Submitting changes

1. Branch from `main`.
2. Make focused commits; run the unit tests + schema check before pushing.
3. Open a PR describing **what** changed and **how you verified** it (include the headless smoke-test result for UI changes).
4. For version-compatibility PRs, say exactly which GNOME Shell version you tested on so `metadata.json`'s `shell-version` can be updated truthfully.

## License

By contributing, you agree your contributions are licensed under [GPL-3.0-or-later](LICENSE).
