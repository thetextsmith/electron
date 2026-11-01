#!/bin/sh
# Puts The Textsmith (Electron edition) on your PATH and in your desktop's
# application menu, beside the main edition.
#   npm install && npm run install-desktop
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
bin="$HOME/.local/bin"
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$bin" "$apps"
# Before 1.0 this edition was called textsmith: that name is the main edition's now.
if [ -L "$bin/textsmith" ] && [ "$(readlink "$bin/textsmith")" = "$here/bin/textsmith" ]; then rm -f "$bin/textsmith"; fi
if [ -f "$apps/textsmith.desktop" ] && grep -q "Exec=$bin/textsmith$" "$apps/textsmith.desktop" && ! [ -x "$bin/textsmith" ]; then rm -f "$apps/textsmith.desktop"; fi
ln -sf "$here/bin/textsmith-electron" "$bin/textsmith-electron"
cat > "$apps/textsmith-electron.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=The Textsmith (Electron edition)
GenericName=Terminal
Comment=A terminal whose output is a web document, written for screen readers first
Exec=$bin/textsmith-electron
Icon=utilities-terminal
Terminal=false
Categories=System;TerminalEmulator;
Keywords=terminal;shell;command;prompt;bookmarks;
X-TerminalArgExec=-e
X-TerminalArgDir=--working-directory
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$apps" >/dev/null 2>&1 || true
echo "Installed: $bin/textsmith-electron and $apps/textsmith-electron.desktop"
case ":$PATH:" in *":$bin:"*) ;; *) echo "Note: $bin is not on your PATH yet; add it in ~/.bashrc to type 'textsmith-electron'.";; esac
