#!/usr/bin/env bash
set -e

EXT="awesome-media-controller@devduo-org"
DEST="$HOME/.local/share/gnome-shell/extensions/$EXT"

echo "Installing Awesome Media Controller..."
mkdir -p "$DEST"

rsync -a --delete \
  --exclude='.git' \
  --exclude='docs' \
  --exclude='tests' \
  --exclude='.superpowers' \
  --exclude='.claude' \
  --exclude='context.txt' \
  --exclude='install.sh' \
  "$(dirname "$0")/" \
  "$DEST/"

echo "Compiling settings schema..."
glib-compile-schemas "$DEST/schemas"

echo "Reloading extension..."
gnome-extensions disable "$EXT" 2>/dev/null || true
sleep 0.5
gnome-extensions enable "$EXT"

echo "Done! Check journalctl for errors:"
echo "  journalctl -f -o cat /usr/bin/gnome-shell | grep -i amc"
