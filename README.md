# The Textsmith, Electron edition

`textsmith-electron`: a different experience of The Textsmith, a terminal
whose output is a web document, written for screen readers first. (The main
edition, `textsmith`, is a native GTK terminal; both read the same bookmarks.
Site and manual: <https://thetextsmith.com>.)

Copyright 2026 Ishe Chinyoka. Distributed under the GNU General Public
License, version 3 or later; see `LICENSE`.

In this edition, each command becomes a heading and
its output is the text under that heading, so a screen reader's heading
navigation moves from command to command. The host and current directory live
in the title bar; there is no prompt line.

The title bar shows your own prompt (your `PS1`, without colours), the shell
and the program name: `[ishe@forge Downloads] — bash — The Textsmith`. With no
`PS1` it shows `user@host: directory`.

## Shells

The Textsmith runs your login shell, as set with `chsh` (read from
/etc/passwd, so a change applies to the next tab or window, without logging
out). bash and zsh are supported; other shells run bash. Preferences, under
Title and start, can choose one regardless of the login shell.

With zsh, your own `.zshenv` and `.zshrc` are read as usual, then The
Textsmith adds its hooks: completion is zsh's own (your compdefs and plugins
included), history comes from `$HISTFILE` (`~/.zsh_history` if unset), and
`INTERACTIVE_COMMENTS` is switched on so `#label: command` bookmarks and
`#@` work. zsh's spelling question ("correct 'sl' to 'ls' [nyae]?") is read
out, and Y, N, A or E answers it without Enter.

Linux and macOS.

## Run

    npm install
    npm start

## Install as your terminal

    npm run install-desktop

This links `textsmith-electron` into `~/.local/bin` and adds The Textsmith
(Electron edition) to your desktop's application menu as a terminal. Before
1.0 this edition was called `textsmith`; that name is the main edition's now,
and an old link is removed. `textsmith-electron` starts a new window
detached from wherever you typed it, so it is safe to run from inside The
Textsmith itself. It takes the options desktops use for "open a terminal
here": `--working-directory DIR` and `-e command args...`.

To make it the default terminal:

- Desktops using xdg-terminal-exec (recent GNOME, KDE and others):
  `echo textsmith-electron.desktop >> ~/.config/xdg-terminals.list`
- MATE: `gsettings set org.mate.applications-terminal exec textsmith-electron`
- Cinnamon: `gsettings set org.cinnamon.desktop.default-applications.terminal exec textsmith-electron`
- Older GNOME: `gsettings set org.gnome.desktop.default-applications.terminal exec textsmith-electron`
- i3 or sway: `bindsym $mod+Return exec textsmith-electron`
- Many programs also honour `export TERMINAL=textsmith-electron` in `~/.profile`.
- For Ctrl+Alt+T, add a custom keyboard shortcut running `textsmith-electron`.

## Preferences

Ctrl+Comma opens them; they are saved as you change them, in
`prefs.json` in The Textsmith's folder. Categories:

- Display: commands as headings or as traditional prompt-and-$ lines (still
  headings underneath), light, dark or high-contrast colours, text size,
  font, and whether program colours are shown.
- Speech: reading output while a command runs, how many lines of finished
  output are read in full, and character and word reading in full-screen
  programs.
- Title and start: the window title (`{prompt} — {shell} — {app}`) and the
  folder new tabs start in.
- Keyboard: every shortcut below can be changed. Press an action's button,
  then the new keys; a combination already in use is refused, and plain
  letters are refused because they would get in the way of typing.

If Electron complains about the sandbox on Linux, use `npm start -- --no-sandbox`.

## Bookmarks

Type a bookmark as a comment, so bash ignores it if you press Enter by
mistake, with a label in front ending in `: `, then press Alt+M:

    #vps: ssh forge                                 call it as: vps
    #sync music: rclone sync <> . --progress        sync drive:Music
    #notes: find . -type f -iname '*<>*'            notes artificial
    #copy: cp <src> <dst>                           copy a.txt backup/
    #burn: dd if=<iso> of=/dev/sdb bs=1M status=progress
    #copy(2): cp                                    exactly 2 arguments, added at the end
    #copy(2..): cp -v                               at least 2
    #l(..1): ls -l                                  at most 1
    #copy(1..3): cp                                 1 to 3
    #burn: dd if=<iso> of=<disk:/dev/sdb>           burn arch.iso   (disk defaults to /dev/sdb)
    #install: sudo apt install -y <..>              install vim git htop   (any number)

`<name:default>` (or `<:default>`) is filled in when your arguments run out
before it. `<..>` (or `<name..>`, repeated by its name) takes every argument
the other places leave over, wherever it stands; add a count such as `(1..)`
to require at least one. The GTK version reads these the same way.

A default can be another place: `#send: rclone sync <from> drive:Library/<to:<from>>`
makes `send Music` mean `rclone sync Music drive:Library/Music`, and
`send Music Songs` still gives the second its own value.

A bookmark can have a command per machine, for bookmarks that travel in
your dotfiles:

    #update: [:anvil "sudo apt update -y && sudo apt upgrade -y", :brainpower "sudo pacman -Syu --noconfirm", :* "echo no update here"]

`:*` is for any other machine; several names can share a command
(`:anvil :forge "..."`). The machine's name is `TEXTSMITH_MACHINE`, else the
first line of `machine` in The Textsmith's folder (keep it out of your dotfiles), else
`/etc/hostname`. The bookmarks file never names the machine: it travels. A
bookmark for one machine only needs no list: `#update: sudo pacman -Syu`.

While a program runs (ssh, tmux), Ctrl+Space and the bookmark list put a
bookmark in the box as input for it, without sending it: Enter sends it.
Inside `ssh forge`, however it was started (an alias, a bookmark), a
bookmark with a command per machine takes forge's command, and the list has
a row for each machine, forge's first.

### Bookmarks at the end of a command: #@name

Bash has no global aliases; `#@` gives you one. Save a bookmark whose label
starts with `|`, and add it to the end of any command:

    #|count: wc -l                  ls -1F #@count            runs  ls -1F | wc -l
    #|grab: grep -i <>              find . #@grab todo @count  runs  find . | grep -i todo | wc -l
    #quiet: 2>/dev/null             make #@quiet               runs  make 2>/dev/null

`|` means "pipe into this"; without it the bookmark's text is simply added.
Several can follow each other (`@grab todo @count`), each with its own
arguments. Tab completes the names after `#@`. Bash reads the `#@` part as a
comment, so a command typed elsewhere loses nothing but the addition.

The label is the name, an optional count in brackets and an optional
description. Only the label is read, so `=`, `$`, `&`, `#` and colons in the
command itself are left alone. A command with no label is a bookmark without
a name. Bookmarks are stored the same way, one per line, in
the bookmarks file; lines there starting with `# ` are notes. The older
forms (`ssh forge#vps`, `ssh forge =vps`) are still read.

- `<>` marks a place for an argument; `<name>` names it. Arguments fill the
  places in order, and a named place used twice gets the same value twice.
- Arguments go in exactly as typed, so quote names with spaces.
- Calling a bookmark with the wrong number of arguments is refused with an
  explanation ("sync takes 1 argument; you gave 0.").
- Alt+M on the same line again removes it; the same name with a new command
  replaces the old one.

They are kept in `bookmarks`, one per line, which you can also edit by hand,
in The Textsmith's folder, shared with the main edition. The folder is the
first of: `TEXTSMITH_CONFIG` (or `TEXTSMITH_HOME`); `~/.textsmith`, if it is
there; `$XDG_CONFIG_HOME/textsmith` (`~/.config/textsmith`).

To keep bash's own `<>` redirection in a bookmark, write it as `\<>`
(`exec 3\<>/dev/tcp/<host>/80`); a backslash before any place keeps it as
written.

## Tests

- `npm test` runs the shell session without the window and prints the
  events, then checks how bookmark lines are read and filled in.
- `npm run test:zsh` repeats the shell-dependent checks with zsh (skipped
  when zsh is not installed).
- `npm run test:ui` starts The Textsmith and drives it from the keyboard:
  commands and headings, the errors view, links, Tab completion, input to
  running programs (secret input must never become a heading), a full-screen
  list program with the F2 page, and reading in vim. It opens a window while
  it runs; on Linux, `xvfb-run -a npm run test:ui` keeps it out of sight. The
  python and vim tests are skipped when those are not installed.

## Keys

- Enter: run the command. While a command is running, the box sends a line of input to it.
  In a program with its own prompt (psql, python, sqlite3) each line you send
  becomes a heading 3 inside that command, with the answer under it.
- Shift+Enter: run the command as administrator. `pacman -Syu` becomes
  `sudo pacman -Syu`.
- Quotes close as they are opened: typing `"` gives `""` with the caret
  between, typing it again steps over it, and Backspace in an empty pair
  removes both. Never after a letter (`it's`) or inside quotes. Parentheses
  are left alone, since `case` uses them unpaired. Can be turned off.
- Readline keys in the command box: Ctrl+A, Ctrl+E, Ctrl+B, Ctrl+F, Alt+B,
  Alt+F, Ctrl+K, Ctrl+U, Ctrl+W, Alt+D, Alt+Backspace, Ctrl+Y, Alt+C, Alt+U,
  Alt+L, Ctrl+T and Alt+. (last word of the previous command), as in bash;
  what is deleted is read out. Turn them off in the preferences for desktop
  keys instead (Ctrl+A selects all, Home and End, Ctrl+arrows by word).
- Pagers: when less, more or man shows its pages in the document (as
  journalctl and git do, and any pager over ssh), the box says "Pager", and
  from an empty box Space gives the next page, B the previous one and Q quits.
- Up / Down in the command box: history, including earlier sessions (read
  from your shell's history file, `~/.bash_history` or `$HISTFILE`; each
  command is saved as soon as it runs).
- Ctrl+R: search history. Type to filter; Down moves into the matches; Enter
  runs one, Ctrl+Enter puts it in the box to edit first.
- Alt+M: bookmark the command in the box and clear the box. Alt+Shift+M
  bookmarks it and runs it (or asks for its arguments). See "Bookmarks" below.
- Ctrl+Space: call a bookmark by name, such as `sync drive:Music`. Tab
  completes the name, then the arguments; Up and Down step through the
  bookmarks; Escape goes back to commands; Shift+Enter runs it with sudo.
- Alt+Shift+B: all bookmarks, newest first. Enter runs one (or asks for its
  arguments). Ctrl+Enter puts the whole bookmark, name and all, in the box to
  edit; Enter then saves it in place of the old one (Escape cancels, an
  emptied box removes it). Delete removes one, typing filters them.
- Tab: complete what is under the caret: commands, files, and whatever the
  program's own bash completion offers (git branches, rustup and adb
  subcommands, systemctl units...), including your own `complete -W`
  word lists. Tab works on the command being typed even inside loops and
  lists (`for f in *; do restic …`, `a && b`, `x | y`, `$( … )`), and
  completes variable names after `$` (`$HOME`, `"$REPO"`, `${PATH}`). With several matches, Tab again steps
  through them and Shift+Tab steps back. Tab never leaves the box.
- Tab while a program is running (a remote shell over ssh or adb, psql,
  python) works the same way: the program completes the line, and the result
  comes back into the box. With several matches, the program's own list is
  read out.
- Ctrl+Shift+C: select and copy. The current block's text (or a full-screen
  program's screen) opens in a read-only text box where Shift+arrows select,
  Ctrl+C copies and Ctrl+A selects everything. Escape goes back.
- Alt+Up / Alt+Down: move to the previous / next heading, commands and their sub-headings alike.
- Escape: back to the command box.
- Alt+1: normal view, stdout and stderr together.
- Alt+2: errors only, what each command wrote to stderr.
- Alt+0: the list of commands. Enter on a command opens its output.
- Ctrl+C with nothing selected: interrupt the running command. Ctrl+D on an empty box: end of input.
- Alt+G: hand the window to the running command as a classic terminal grid, and back.
- Ctrl+Shift+T: new tab with its own shell. Ctrl+PageDown and Ctrl+PageUp (or
  Ctrl+Tab and Ctrl+Shift+Tab) move between tabs, and the tab you land on says
  which it is ("Tab 2 of 3, ~/Downloads"). Ctrl+Shift+W or `exit` closes a
  tab. These keys work inside full-screen programs too.

When a program asks for a password (sudo, ssh, `read -s`), the box says so and
hides what you type, and the password never appears in the document.

Full-screen programs (vim, neomutt, htop) take over the window by themselves
and the title becomes "Vim, active". Quitting them returns to the document.

When a full-screen program steps aside, prints something and waits (neomutt
with an external pager, vim after `:!make`), that text gets a heading 3 named
after its first line and focus moves to it. Escape returns to the box, and
Enter there usually tells the program to carry on.

To read mail as document text, tell neomutt to hand messages to `cat` when it
runs inside The Textsmith. In `neomuttrc`:

    set pager=`[ -n "$TEXTSMITH" ] && echo cat || echo builtin`

(`$ANVIL` is still set too, so older configs keep working.)

F2 (or Alt+R) turns a full-screen program's screen into a web page. Its list
(neomutt's messages, htop's processes, a menu) becomes a list of buttons:
Enter on one moves the program's selection there and presses Enter, so in
neomutt it opens that message; Shift+Enter only moves the selection. Other
lines are plain text. A "Keys" field at the bottom sends keys to the program as
typed (`q`, `d`, `/`), an empty field sends Enter, and named keys go in angle
brackets: `<esc>`, `<pgdn>`, `<up>`. F5 refreshes the page; F2 or Escape goes
back to the program. Alt+1 from there reads the whole session document while
the program waits. When a program has stepped aside by itself (neomutt
showing a message as text), F2 tells it to carry on.

Inside a full-screen program, The Textsmith speaks for it:

- Moving to another line reads that line.
- Left and right (arrows, or h and l in vim) read the character under the
  cursor; jumps such as w, b or Ctrl+arrows read the word.
- In lists (neomutt's index, htop, menus) the highlighted row is read as the
  selection moves, even when the program parks its cursor elsewhere. For
  neomutt, `set braille_friendly` also puts the cursor on the selected line.
- Typing a space reads the word just finished.
- A new message on the bottom line (vim's mode and messages) is read out.
- Alt+L: read the line under the cursor.
- Alt+S: read the bottom line.

In output, web addresses open in the browser and references such as `ls(1)`
run `man 1 ls`. Pagers are switched off (`PAGER=cat`), so man pages and
`git log` arrive as ordinary document text.

## How it is put together

- `shell/zsh/.zshenv`, `shell/zsh/.zshrc`: the same for zsh, which is started
  with `ZDOTDIR` pointing there and reads your own files from it.
- `shell/textsmith.bashrc`: shell integration. Marks where each command ends,
  reports the directory, and sends each command's stderr down a separate pipe.
- `session.js`: runs bash on a pty, turns the stream into events, and keeps a
  small terminal emulator per command so progress bars and `\r` rewrites
  settle into their final text. No Electron in here.
- `main.js`, `preload.js`: the Electron window and the bridge to the page.
- `renderer/`: the page itself.

## Known gaps

- stdout and stderr travel separately, so in the combined view a line of
  stderr can land slightly before or after neighbouring stdout.
- Programs see that stderr is not a terminal; some drop colour or progress
  output there.
- A password prompt from a remote machine (sudo over ssh) is recognised by its
  wording ("Password:"); one worded differently will not hide your typing.
- No fish integration yet.
- Output of a running command is read out whenever it pauses for a moment,
  which is what makes sqlite3 or python answer after each line. A long build
  that pauses often will be chatty; there is no switch for that yet.
