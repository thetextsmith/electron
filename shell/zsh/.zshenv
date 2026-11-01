# The Textsmith: zsh integration, first stage.
# The Textsmith starts zsh with ZDOTDIR pointing here, so that after your own
# files it can add its hooks from the .zshrc beside this one. Your .zshenv is
# read from where it always is.
__anvil_zdotdir=$ZDOTDIR
ZDOTDIR=${TEXTSMITH_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && source "$ZDOTDIR/.zshenv"
TEXTSMITH_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$__anvil_zdotdir
unset __anvil_zdotdir
