#!/bin/zsh
# Finder Quick Action "Save Image to Inspiration Board": sends the selected photos (and the
# photos inside selected folders) to the image-downloader server, which saves them on the
# Mac mini's Inspiration Board like a web save (JPEG, camera details kept, location removed).
# Installed by install.sh, which puts this script inside the Quick Action.
#
# Settings: ~/.config/inspo-board/config (asked for on first use)
#   API_KEY           the server's key (the one in the Chrome extension's options)
#   SCAN_WEBHOOK_URL  optional: the Immich scan webhook (the webhook-trigger button's address),
#                     called after the photos are sent so they show up in Immich
#   SERVER_URL        optional: defaults to https://inspo-dl.make3.co

CONFIG="$HOME/.config/inspo-board/config"
SERVER_URL="https://inspo-dl.make3.co"
API_KEY=""
SCAN_WEBHOOK_URL=""
[[ -f $CONFIG ]] && source "$CONFIG"

TITLE="Inspiration Board"
MAX_BYTES=$((50 * 1024 * 1024))   # the server's limit per photo

# Show a message; with "ask", return what was typed (empty if cancelled)
dialog() {
  osascript - "$@" <<'EOF' 2>/dev/null
on run argv
  set msg to item 1 of argv
  if (count of argv) > 1 then
    set mode to item 2 of argv
    if mode is "secret" then
      return text returned of (display dialog msg default answer "" with hidden answer with title "Inspiration Board")
    else
      return text returned of (display dialog msg default answer "" with title "Inspiration Board")
    end if
  end if
  display dialog msg buttons {"OK"} default button "OK" with title "Inspiration Board"
end run
EOF
}

notify() {
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Inspiration Board"' -e 'end run' "$1" >/dev/null 2>&1
}

save_config() {
  mkdir -p "${CONFIG:h}"
  {
    print -r -- "API_KEY=${(q)API_KEY}"
    print -r -- "SCAN_WEBHOOK_URL=${(q)SCAN_WEBHOOK_URL}"
    [[ $SERVER_URL != https://inspo-dl.make3.co ]] && print -r -- "SERVER_URL=${(q)SERVER_URL}"
  } > "$CONFIG"
  chmod 600 "$CONFIG"
}

urlencode() {
  print -rn -- "$1" | /usr/bin/perl -pe 's/([^A-Za-z0-9._~-])/sprintf("%%%02X", ord($1))/ge'
}

# First use: ask for the key (and the optional scan webhook)
if [[ -z $API_KEY ]]; then
  API_KEY=$(dialog "Paste the image-downloader API key (the same one as in the Chrome extension's options):" secret)
  [[ -z $API_KEY ]] && exit 0
  SCAN_WEBHOOK_URL=$(dialog "Optional: the Immich scan webhook address (the same one as in the scan button's options), so new photos show up in Immich right away. Leave empty to skip." text)
  save_config
fi

# The photos: selected files, plus image files inside selected folders
setopt extendedglob nullglob nocaseglob
IMAGE_EXTS='(jpg|jpeg|png|webp|avif|tif|tiff|heic|heif|bmp|jxl|dng|cr2|cr3|nef|arw|raf|orf|rw2)'
files=()
for arg in "$@"; do
  if [[ -d $arg ]]; then
    files+=("$arg"/**/*.${~IMAGE_EXTS}(.N))
  elif [[ -f $arg ]]; then
    files+=("$arg")
  fi
done
(( ${#files} )) || { dialog "No photos in the selection."; exit 0; }

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT

sent=0
failed=()
for f in "${files[@]}"; do
  name=${f:t}
  ext=${${f:e}:l}
  send=$f
  # The server can't read HEIC or camera raw files: turn them into JPEG here first (sips keeps
  # the camera details; the server removes the location). Very large files too.
  size=$(stat -f %z "$f")
  if [[ $ext == (heic|heif|dng|cr2|cr3|nef|arw|raf|orf|rw2|bmp) ]] || (( size > MAX_BYTES )); then
    send="$tmp/${name:r}.jpg"
    if ! /usr/bin/sips -s format jpeg -s formatOptions 92 "$f" --out "$send" >/dev/null 2>&1; then
      failed+=("$name: couldn't convert it to JPEG")
      continue
    fi
    (( $(stat -f %z "$send") > MAX_BYTES )) && { failed+=("$name: too large (over 50 MB)"); continue; }
  fi

  code=$(/usr/bin/curl -sS -o "$tmp/reply" -w '%{http_code}' --max-time 300 \
    -X POST "$SERVER_URL/upload-bytes" \
    -H "X-API-Key: $API_KEY" \
    -H "X-File-Name: $(urlencode "$name")" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$send" 2>"$tmp/curl-error")
  if [[ $code == 200 ]]; then
    (( sent++ ))
  elif [[ $code == 401 ]]; then
    # Wrong key: forget it so the next run asks again
    API_KEY=""
    save_config
    dialog "The server didn't accept the API key. Run the Quick Action again to enter it. ($sent sent before this.)"
    exit 1
  else
    reason=$(/usr/bin/perl -0ne 'print $1 if /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/' "$tmp/reply" 2>/dev/null)
    [[ -z $reason ]] && reason=$(<"$tmp/curl-error")
    [[ -z $reason ]] && reason="server answered $code"
    failed+=("$name: $reason")
  fi
done

if (( sent )) && [[ -n $SCAN_WEBHOOK_URL ]]; then
  /usr/bin/curl -fsS --max-time 30 "$SCAN_WEBHOOK_URL" >/dev/null 2>&1 || failed+=("(the Immich scan didn't start; use the scan button)")
fi

photos() { (( $1 == 1 )) && print "1 photo" || print "$1 photos"; }
if (( ${#failed} )); then
  dialog "Saved $(photos $sent). Not saved:"$'\n\n'"${(F)failed[1,15]}$( (( ${#failed} > 15 )) && print "\n…and $(( ${#failed} - 15 )) more")"
else
  notify "Saved $(photos $sent) to the Inspiration Board."
fi
