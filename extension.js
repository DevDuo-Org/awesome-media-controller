import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import { abortArtRequests } from './lib/art.js';
import { MprisWatcher } from './lib/mpris.js';
import { PanelWidget } from './lib/panel-widget.js';
import { ThemeManager } from './lib/theme.js';

export default class AwesomeMediaController extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._watcher  = new MprisWatcher();
        this._theme    = new ThemeManager(this._settings);
        this._createWidget();

        // Moving between panel boxes requires recreating the indicator
        this._positionId = this._settings.connect('changed::panel-position', () => {
            this._widget?.destroy();
            this._createWidget();
        });
    }

    _createWidget() {
        this._widget = new PanelWidget(this._watcher, this._theme, this._settings);
    }

    disable() {
        if (this._positionId) {
            this._settings.disconnect(this._positionId);
            this._positionId = 0;
        }
        this._widget?.destroy();
        this._widget = null;
        this._theme?.destroy();
        this._theme = null;
        this._watcher?.destroy();
        this._watcher = null;
        this._settings = null;
        abortArtRequests();
    }
}
