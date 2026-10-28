#!/bin/sh
# Removes Spektronautilus (the program and the menu entry). Your browser settings stay in ~/.config/spektronautilus (delete it by hand if you want).
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/spektronautilus"
rm -rf "$DEST" "$HOME/.local/bin/spektronautilus" "${XDG_DATA_HOME:-$HOME/.local/share}/applications/spektronautilus.desktop"
echo "Removed."
