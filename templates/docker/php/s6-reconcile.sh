#!/bin/sh
set -eu

# Reconcile the bind-mounted Bento service definitions into a mutable s6 scan
# tree. s6-supervise owns state below /run; generated definitions remain
# read-only and can be replaced atomically by `bento apply`.
SOURCE="${BENTO_S6_SOURCE:-/etc/bento/services}"
DEFINITIONS="${BENTO_S6_DEFINITIONS:-/run/bento-s6/definitions}"
SCAN="${BENTO_S6_SCAN:-/run/bento-s6/services}"
INITIAL=false
[ "${1:-}" = "--initial" ] && INITIAL=true

mkdir -p "$SOURCE" "$DEFINITIONS" "$SCAN"
changed=""

# Copy definitions without touching s6's live supervise directory.
for src in "$SOURCE"/*; do
  [ -d "$src" ] || continue
  name=${src##*/}
  case "$name" in
    *[!A-Za-z0-9_-]*)
      echo "bento-s6-reconcile: refusing invalid service name: $name" >&2
      continue
      ;;
  esac
  dst="$DEFINITIONS/$name"
  is_changed=false
  [ -d "$dst" ] || { mkdir -p "$dst"; is_changed=true; }

  for old in "$dst"/*; do
    [ -e "$old" ] || continue
    base=${old##*/}
    [ "$base" = "supervise" ] && continue
    if [ ! -e "$src/$base" ]; then
      rm -rf "$old"
      is_changed=true
    fi
  done

  for file in "$src"/*; do
    [ -f "$file" ] || continue
    base=${file##*/}
    target="$dst/$base"
    if [ ! -f "$target" ] || ! cmp -s "$file" "$target"; then
      cp "$file" "$target.tmp"
      chmod "$(stat -c '%a' "$file")" "$target.tmp"
      mv -f "$target.tmp" "$target"
      is_changed=true
    fi
  done

  if [ ! -L "$SCAN/$name" ]; then
    ln -s "$dst" "$SCAN/$name"
  elif [ "$is_changed" = true ]; then
    changed="$changed $name"
  fi
done

# Stop and unlink definitions removed from desired state. Only symlinks created
# by this reconciler are considered.
removed=""
for link in "$SCAN"/*; do
  [ -L "$link" ] || continue
  name=${link##*/}
  if [ ! -d "$SOURCE/$name" ]; then
    if [ "$INITIAL" = false ] && [ -e "$link/supervise/ok" ]; then
      /command/s6-svc -d "$link" 2>/dev/null || true
      /command/s6-svwait -D -t 15000 "$link" 2>/dev/null || true
    fi
    rm -f "$link"
    removed="$removed $name"
  fi
done

if [ "$INITIAL" = false ]; then
  /command/s6-svscanctl -a "$SCAN"
  # Existing services consume a changed run definition only after a scoped
  # restart. New services are started automatically by s6-svscan.
  for name in $changed; do
    /command/s6-svc -r "$SCAN/$name"
  done
fi

for name in $removed; do
  rm -rf "$DEFINITIONS/$name"
done
