#!/bin/bash
# A tiny full-screen list program for the tests: highlighted selection,
# cursor parked away from it, arrow keys or j/k to move, Enter to choose.
items=("apple pie" "banana bread" "cherry tart" "date loaf" "elderberry jam"); sel=0; msg=
printf '\e[?1049h'
draw() { printf '\e[H\e[2J\e[7m Fruit menu   j/k move, q quit \e[0m\n'; for i in "${!items[@]}"; do if ((i==sel)); then printf '\e[7m  %-30s\e[0m\n' "${items[i]}"; else printf '  %-30s\n' "${items[i]}"; fi; done; printf '\n%s' "$msg"; printf '\e[20;1H'; }
draw
while IFS= read -rsn1 k; do
  if [[ $k == $'\e' ]]; then read -rsn2 -t 0.1 r; k=$k$r; fi
  case $k in j|$'\e[B'|$'\eOB') ((sel<4 && sel++));; k|$'\e[A'|$'\eOA') ((sel>0 && sel--));; '') msg="You chose ${items[sel]}";; q) break;; esac; draw
done
printf '\e[?1049l'
