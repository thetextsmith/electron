# The Textsmith: shell integration for bash.
#
# What it does:
#   - tells The Textsmith when a command has finished and with which exit code (OSC 133;D)
#   - tells The Textsmith when the shell is ready for the next command   (OSC 133;A)
#   - reports the current directory for the title bar             (OSC 7)
#   - sends each command's stderr down a separate pipe so The Textsmith can show
#     "errors only", while stdout stays on the terminal as usual
#
# There is no visible prompt: The Textsmith shows host and directory in the title bar.

[ -f ~/.bashrc ] && . ~/.bashrc

# fd 198: the stderr pipe The Textsmith reads.  fd 199: the terminal's own stderr.
exec 198>"$ANVIL_ERR_FIFO" 199>&2

# Keep whatever the user's own setup put in PROMPT_COMMAND (direnv, zoxide...).
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  __anvil_user_pc=("${PROMPT_COMMAND[@]}")
else
  __anvil_user_pc=("${PROMPT_COMMAND-}")
fi
unset PROMPT_COMMAND

__anvil_precmd() {
  local __anvil_ec=$?
  __anvil_last_ec=$__anvil_ec
  exec 2>&199                                  # stderr back to the terminal
  printf '\036' >&198                          # "end of this command's stderr"
  printf '\033]133;D;%s\007' "$__anvil_ec"     # command finished
  history -a 2>/dev/null                       # saved now, so new tabs and windows see it
  local __anvil_c
  for __anvil_c in "${__anvil_user_pc[@]}"; do
    [[ -n $__anvil_c ]] && eval "$__anvil_c"
  done
  # Your own prompt goes to the title bar instead of the screen.
  [[ -n $PS1 ]] && __anvil_ps1=$PS1
  if [[ -n $__anvil_ps1 ]]; then
    local __anvil_p=${__anvil_ps1@P}
    __anvil_p=${__anvil_p//$'\e]'*([^$'\a'])$'\a'/}        # title-setting sequences
    __anvil_p=${__anvil_p//$'\e['*([0-9;?])[A-Za-z]/}       # colours
    __anvil_p=${__anvil_p//[$'\001\002\e\a']/}
    __anvil_p=${__anvil_p%%$'\n'*}
    printf '\033]7772;%s\007' "$__anvil_p"
  fi
  PS1='' PS2=''
  stty -echo 2>/dev/null                       # The Textsmith shows the command itself
  printf '\033]7;file://%s%s\007\033]133;A\007' "${HOSTNAME:-localhost}" "$PWD"
  __anvil_armed=1
}

__anvil_preexec() {
  [[ -n $__anvil_armed ]] || return
  [[ $BASH_COMMAND == __anvil_precmd ]] && return
  __anvil_armed=
  printf '\033]133;C\007'                         # output starts
  stty echo 2>/dev/null                        # programs see a normal terminal
  exec 2>&198                                  # this command's stderr -> The Textsmith
}

# Program-specific completions (git, rustup, adb, systemctl...) come from the
# bash-completion package. Load it if the user's own setup has not.
if ! declare -F _completion_loader >/dev/null && ! declare -F _comp_load >/dev/null; then
  for __anvil_f in /usr/share/bash-completion/bash_completion /etc/bash_completion; do
    [[ -r $__anvil_f ]] && { . "$__anvil_f"; break; }
  done
  unset __anvil_f
fi

# Tab completion. The Textsmith runs this behind the scenes, in this very shell, so it
# sees the current directory, aliases, functions and completion scripts.
# Arguments: index of the word being completed, the line up to the caret, then
# the words of that line as typed. The answer goes back in a private escape
# sequence; it leaves no trace in history or in $?.
__anvil_complete() {
  shopt -s extglob
  [[ $(HISTTIMEFORMAT='' history 1) == *__anvil_complete* ]] && history -d -1 2>/dev/null
  local cword=$1 line=$2; shift 2
  local -a words=("$@") list=()
  local cur=${words[cword]} prev= cmd=${words[0]} spec= func= ccmd= files= c
  (( cword > 0 )) && prev=${words[cword-1]}
  # A variable name: $RE, "$RE or ${RE.
  if [[ $cur == *'$'* && $cur != *"'"* ]]; then
    local pre=${cur%\$*} v=${cur##*\$} brace=
    [[ $v == '{'* ]] && { brace=1; v=${v#\{}; }
    mapfile -t list < <(compgen -v -- "$v" | head -n 500)
    printf '\033]7771;'
    for c in "${list[@]}"; do
      if [[ -n $brace ]]; then printf '%s\n' "$pre"'${'"$c"'}'; else printf '%s\n' "$pre"'$'"$c"; fi
    done
    printf '\007'
    return "${__anvil_last_ec:-0}"
  fi
  if (( cword == 0 )); then
    if [[ $cur == */* ]]; then files=1
    else mapfile -t list < <(compgen -c -- "$cur" | sort -u | head -n 500); fi
  else
    spec=$(complete -p -- "$cmd" 2>/dev/null)
    [[ -z $spec && $cmd == */* ]] && spec=$(complete -p -- "${cmd##*/}" 2>/dev/null)
    if [[ -z $spec ]]; then                       # completion scripts load on first use
      if declare -F _comp_load >/dev/null; then _comp_load -- "$cmd" >/dev/null 2>&1
      elif declare -F __load_completion >/dev/null; then __load_completion "$cmd" >/dev/null 2>&1
      elif declare -F _completion_loader >/dev/null; then _completion_loader "$cmd" >/dev/null 2>&1
      fi
      spec=$(complete -p -- "$cmd" 2>/dev/null)
    fi
    [[ $spec =~ \ -F\ ([^ ]+) ]] && func=${BASH_REMATCH[1]}
    [[ $spec =~ \ -C\ ([^ \']+) ]] && ccmd=${BASH_REMATCH[1]}
    if [[ -n $func ]]; then
      local COMP_WORDS=("${words[@]}") COMP_CWORD=$cword COMP_LINE=$line COMP_POINT=${#line} COMP_TYPE=9 COMP_KEY=9
      local -a COMPREPLY=()
      "$func" "$cmd" "$cur" "$prev" </dev/null >/dev/null 2>&1
      list=("${COMPREPLY[@]}")
    elif [[ -n $ccmd ]]; then
      mapfile -t list < <(COMP_LINE=$line COMP_POINT=${#line} "$ccmd" "$cmd" "$cur" "$prev" </dev/null 2>/dev/null)
    elif [[ -n $spec ]]; then
      # Word lists and the like (complete -W "docs project" backup.sh): compgen
      # takes the same options, minus the command name at the end.
      local opts=${spec#complete }
      opts=${opts% *}
      mapfile -t list < <(eval "compgen $opts -- \"\$cur\"" 2>/dev/null | head -n 500)
    fi
    (( ${#list[@]} == 0 )) && files=1             # nothing from the script: offer files
  fi
  if [[ -n $files ]]; then
    local word=${cur//\\/} tilde=
    word=${word//[\"\']/}                             # quotes are not part of the name
    if [[ $word == "~/"* ]]; then tilde=1; word="$HOME/${word#\~/}"; fi
    mapfile -t list < <(compgen -f -- "$word" | head -n 500)
    if [[ -n $tilde ]]; then for c in "${!list[@]}"; do list[c]="~/${list[c]#"$HOME"/}"; done; fi
  fi
  printf '\033]7771;'
  for c in "${list[@]:0:500}"; do
    c=${c%%+([[:space:]])}                      # some scripts add their own trailing space
    [[ -d ${c/#\~/$HOME} && $c != */ ]] && c+=/
    printf '%s\n' "$c"
  done
  printf '\007'
  return "${__anvil_last_ec:-0}"
}

trap '__anvil_preexec' DEBUG
PROMPT_COMMAND=__anvil_precmd
