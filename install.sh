#!/bin/sh
# Installs Spektronautilus for the current user (no root needed). Run it from the unpacked folder.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/spektronautilus"
BIN="$HOME/.local/bin"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
command -v python3 >/dev/null || { echo "Python 3 is needed (sudo apt install python3)."; exit 1; }
mkdir -p "$DEST" "$BIN" "$APPS"
rm -rf "$DEST/docs"
cp -r "$HERE/docs" "$HERE/spektronautilus.py" "$HERE/spektronautilus.svg" "$HERE/README-LINUX.txt" "$HERE/uninstall.sh" "$DEST/"
chmod +x "$DEST/spektronautilus.py" "$DEST/uninstall.sh"
ln -sf "$DEST/spektronautilus.py" "$BIN/spektronautilus"
cat > "$APPS/spektronautilus.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Spektronautilus
GenericName=VJ and video mixer
Comment=Live video mixers and loop tools for VJs
Exec=python3 "$DEST/spektronautilus.py"
Icon=$DEST/spektronautilus.svg
Terminal=false
Categories=AudioVideo;Video;
Actions=live;vj;tools;

[Desktop Action live]
Name=Video DJ
Exec=python3 "$DEST/spektronautilus.py" --path live-dj/

[Desktop Action vj]
Name=VJ Mixer
Exec=python3 "$DEST/spektronautilus.py" --path vj-pad/

[Desktop Action tools]
Name=Loop tools
Exec=python3 "$DEST/spektronautilus.py" --path tools/app/
DESK
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
echo "Installed in $DEST"
echo "Start it from your application menu (Spektronautilus), or type:  spektronautilus"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Note: $BIN is not in your PATH yet. Log out and in again, or use the menu entry.";; esac
command -v ffmpeg >/dev/null || echo "Tip: install ffmpeg for fast converting:  sudo apt install ffmpeg"
command -v google-chrome >/dev/null || command -v google-chrome-stable >/dev/null || command -v chromium >/dev/null || command -v chromium-browser >/dev/null || echo "Tip: install Google Chrome or Chromium for the best result with live visuals."
