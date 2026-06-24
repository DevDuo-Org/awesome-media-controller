import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { PRESETS } from './lib/theme.js';

function hexFromRgba(rgba) {
    const c = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${c(rgba.red)}${c(rgba.green)}${c(rgba.blue)}`;
}

export default class AmcPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({ title: 'Awesome Media Controller', icon_name: 'audio-x-generic-symbolic' });
        window.add(page);

        // ── Theme ─────────────────────────────────────────────────────────
        const themeGroup = new Adw.PreferencesGroup({
            title: 'Theme',
            description: 'Adaptive mode extracts accent colors from the current album art',
        });
        page.add(themeGroup);

        const modes = ['adaptive', 'preset', 'custom'];
        const modeRow = new Adw.ComboRow({
            title: 'Accent colors',
            model: Gtk.StringList.new(['Adaptive (from album art)', 'Preset theme', 'Custom']),
        });
        modeRow.selected = Math.max(0, modes.indexOf(settings.get_string('accent-mode')));
        modeRow.connect('notify::selected', () => {
            settings.set_string('accent-mode', modes[modeRow.selected]);
        });
        themeGroup.add(modeRow);

        const presetNames = Object.keys(PRESETS);
        const presetRow = new Adw.ComboRow({
            title: 'Preset theme',
            model: Gtk.StringList.new(presetNames.map((n) => PRESETS[n].label)),
        });
        presetRow.selected = Math.max(0, presetNames.indexOf(settings.get_string('theme-preset')));
        presetRow.connect('notify::selected', () => {
            settings.set_string('theme-preset', presetNames[presetRow.selected]);
        });
        themeGroup.add(presetRow);

        const colorRow = (title, key) => {
            const row = new Adw.ActionRow({ title });
            const rgba = new Gdk.RGBA();
            rgba.parse(settings.get_string(key));
            const btn = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({ with_alpha: false }),
                rgba,
                valign: Gtk.Align.CENTER,
            });
            btn.connect('notify::rgba', () => settings.set_string(key, hexFromRgba(btn.get_rgba())));
            row.add_suffix(btn);
            row.activatable_widget = btn;
            return row;
        };

        const startRow = colorRow('Gradient start', 'accent-start');
        const endRow   = colorRow('Gradient end', 'accent-end');
        themeGroup.add(startRow);
        themeGroup.add(endRow);

        const syncSensitive = () => {
            const mode = settings.get_string('accent-mode');
            presetRow.sensitive = mode === 'preset';
            startRow.sensitive  = mode === 'custom';
            endRow.sensitive    = mode === 'custom';
        };
        settings.connect('changed::accent-mode', syncSensitive);
        syncSensitive();

        // ── Panel ─────────────────────────────────────────────────────────
        const panelGroup = new Adw.PreferencesGroup({ title: 'Panel' });
        page.add(panelGroup);

        const positions = ['left', 'center', 'right'];
        const posRow = new Adw.ComboRow({
            title: 'Position in top bar',
            model: Gtk.StringList.new(['Left', 'Center', 'Right']),
        });
        posRow.selected = Math.max(0, positions.indexOf(settings.get_string('panel-position')));
        posRow.connect('notify::selected', () => {
            settings.set_string('panel-position', positions[posRow.selected]);
        });
        panelGroup.add(posRow);

        const switchRow = (title, subtitle, key) => {
            const row = new Adw.SwitchRow({ title, subtitle });
            settings.bind(key, row, 'active', 0 /* Gio.SettingsBindFlags.DEFAULT */);
            return row;
        };
        panelGroup.add(switchRow('Playback buttons in pill', 'Show prev/play/next directly in the top bar', 'show-pill-controls'));
        panelGroup.add(switchRow('Marquee titles', 'Scroll long track titles in the pill', 'enable-marquee'));
        panelGroup.add(switchRow('Animations', 'EQ bars, glow pulse, and popup transitions', 'enable-animations'));

        // ── About ─────────────────────────────────────────────────────────
        const aboutGroup = new Adw.PreferencesGroup({ title: 'About' });
        page.add(aboutGroup);

        const version = this.metadata?.version ? `v${this.metadata.version}` : '';
        const aboutRow = new Adw.ActionRow({
            title: 'Awesome Media Controller',
            subtitle: `by DevDuo Innovations${version ? ` · ${version}` : ''}`,
        });
        aboutRow.add_prefix(new Gtk.Image({
            icon_name: 'audio-x-generic-symbolic',
            pixel_size: 32,
            valign: Gtk.Align.CENTER,
        }));
        aboutGroup.add(aboutRow);

        const linkRow = (title, subtitle, uri) => {
            const row = new Adw.ActionRow({ title, subtitle });
            const btn = new Gtk.LinkButton({ uri, label: 'Open', valign: Gtk.Align.CENTER });
            row.add_suffix(btn);
            row.activatable_widget = btn;
            return row;
        };

        aboutGroup.add(linkRow('Project page', 'Source, issues, and releases on GitHub',
            'https://github.com/DevDuo-Org/awesome-media-controller'));
        aboutGroup.add(linkRow('Support development', 'Sponsor DevDuo Innovations',
            'https://github.com/sponsors/DevDuo-Org'));
    }
}
