# The Textsmith: zsh integration.
#
#   - tells The Textsmith where each command's output starts (OSC 133;C), when
#     it has finished and with which exit code (133;D), and when the shell is
#     ready for the next one (133;A)
#   - reports the directory (OSC 7) and your prompt (7772) for the title bar
#   - sends each command's stderr down a separate pipe for the errors view
#   - runs commands and completions handed over by The Textsmith (see the two
#     widgets at the end), so nothing has to be typed into the line editor
#
# Your own .zshrc is read first, so your options, plugins and completions apply.

ZDOTDIR=${TEXTSMITH_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshrc ]] && source "$ZDOTDIR/.zshrc"

# Commands can end in a comment, as bookmarks do: #name: command
setopt INTERACTIVE_COMMENTS
# No "%" marker or carriage return before an empty prompt line.
unsetopt PROMPT_SP PROMPT_CR 2>/dev/null
PROMPT_EOL_MARK=''

# History lives in a file, so Up in a new tab or window reaches it.
[[ -z $HISTFILE ]] && HISTFILE=$HOME/.zsh_history
(( SAVEHIST )) || SAVEHIST=10000
(( HISTSIZE >= SAVEHIST )) || HISTSIZE=$SAVEHIST

# The stderr pipe The Textsmith reads, and the terminal's own stderr.
exec {__anvil_errfd}>"$ANVIL_ERR_FIFO" {__anvil_ttyfd}>&2

__anvil_first() {                       # runs first: $? is still the command's
  local ec=$?
  exec 2>&$__anvil_ttyfd
  print -rn -- $'\036' >&$__anvil_errfd
  print -rn -- $'\e]133;D;'$ec$'\a'
}
__anvil_last() {                        # runs last, after your own precmd hooks
  setopt localoptions extendedglob
  fc -AI 2>/dev/null                    # save new history lines now
  [[ -n $PS1 ]] && __anvil_ps1=$PS1
  local p=${(%)__anvil_ps1}
  p=${p//$'\e]'[^$'\a']#$'\a'/}          # title-setting sequences
  p=${p//$'\e['[0-9;?]#[A-Za-z]/}        # colours
  p=${p//[$'\e\a']/}
  p=${p%%$'\n'*}
  print -rn -- $'\e]7772;'$p$'\a'
  PS1='' RPS1='' RPROMPT='' PS2=''
  print -rn -- $'\e]7;file://'$HOST$PWD$'\a\e]133;A\a'
}
__anvil_preexec() {
  print -rn -- $'\e]133;C\a'
  exec 2>&$__anvil_errfd
}
precmd_functions=(__anvil_first ${precmd_functions:#__anvil_*} __anvil_last)
preexec_functions=(${preexec_functions:#__anvil_*} __anvil_preexec)

# ---- Running a command: The Textsmith writes the line to a file and presses
# a private key; the line goes in whole, as if typed, and is accepted.
__anvil_run() {
  BUFFER=$(<"$ANVIL_TMP/line")
  CURSOR=$#BUFFER
  zle accept-line
}
zle -N __anvil-run __anvil_run

# ---- Completion: zsh's own completion system runs on the line, and the
# matches are collected instead of shown (the method of zsh-capture-completion).
if (( ! $+functions[_main_complete] )); then
  autoload -Uz compinit
  mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}"
  compinit -i -d "${XDG_CACHE_HOME:-$HOME/.cache}/textsmith-zcompdump"
fi
typeset -ga __anvil_hits
__anvil_compadd() {
  if [[ ${@[1,(i)(-|--)]} == *-(O|A|D)\ * ]]; then builtin compadd "$@"; return $?; fi
  local -a __h
  builtin compadd -A __h "$@"
  setopt localoptions norcexpandparam extendedglob
  typeset -A apre hpre hsuf asuf
  zparseopts -E P:=apre p:=hpre S:=asuf s:=hsuf
  local i
  for i in {1..$#__h}; do
    __anvil_hits+=("$IPREFIX$apre$hpre$__h[$i]$hsuf$asuf")
  done
}
__anvil_complete() {
  BUFFER=$(<"$ANVIL_TMP/line")
  CURSOR=$#BUFFER
  __anvil_hits=()
  functions[compadd]=$functions[__anvil_compadd]
  zle __anvil-comp 2>/dev/null
  unfunction compadd 2>/dev/null
  local -a out=("${(@u)__anvil_hits}") dirs=()
  local h
  for h in $out; do
    [[ $h != */ && -d ${~h} ]] 2>/dev/null && h+=/
    dirs+=("$h")
  done
  BUFFER=''
  print -rn -- $'\e]7771;'${(pj:\n:)dirs}$'\a\e]133;A\a'
}
zle -C __anvil-comp complete-word _main_complete
zle -N __anvil-complete __anvil_complete

local __anvil_km
for __anvil_km in emacs viins vicmd; do
  bindkey -M $__anvil_km $'\e[9998~' __anvil-run
  bindkey -M $__anvil_km $'\e[9999~' __anvil-complete
done
unset __anvil_km
