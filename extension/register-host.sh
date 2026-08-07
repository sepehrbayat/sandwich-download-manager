#!/usr/bin/env sh
set -eu

host_name="dev.sandwich.download_manager"
firefox_id="sandwich@sandwich.dev"
chrome_id=""
edge_id=""
host_binary=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --chrome-id) chrome_id="$2"; shift 2 ;;
    --edge-id) edge_id="$2"; shift 2 ;;
    --host-binary) host_binary="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$host_binary" ] || [ ! -x "$host_binary" ]; then
  echo "usage: register-host.sh --host-binary /absolute/path/to/sandwich-browser-host [--chrome-id ID] [--edge-id ID]" >&2
  exit 2
fi

case "$host_binary" in
  /*) ;;
  *) echo "--host-binary must be an absolute path" >&2; exit 2 ;;
esac

manifest_root="${XDG_DATA_HOME:-$HOME/.local/share}/dev.sandwich.download-manager"
mkdir -p "$manifest_root"
chrome_manifest="$manifest_root/native-host-chromium.json"
edge_manifest="$manifest_root/native-host-edge.json"
firefox_manifest="$manifest_root/native-host-firefox.json"

if [ -n "$chrome_id" ]; then
  chrome_origins="[\"chrome-extension://$chrome_id/\"]"
else
  chrome_origins="[]"
fi
if [ -n "$edge_id" ]; then
  edge_origins="[\"chrome-extension://$edge_id/\"]"
elif [ -n "$chrome_id" ]; then
  edge_origins="$chrome_origins"
else
  edge_origins="[]"
fi

cat > "$chrome_manifest" <<EOF
{"name":"$host_name","description":"Sandwich Download Manager browser bridge","path":"$host_binary","type":"stdio","allowed_origins":$chrome_origins}
EOF
cat > "$edge_manifest" <<EOF
{"name":"$host_name","description":"Sandwich Download Manager browser bridge","path":"$host_binary","type":"stdio","allowed_origins":$edge_origins}
EOF
cat > "$firefox_manifest" <<EOF
{"name":"$host_name","description":"Sandwich Download Manager browser bridge","path":"$host_binary","type":"stdio","allowed_extensions":["$firefox_id"]}
EOF

if [ "$(uname -s)" = "Darwin" ]; then
  chrome_target="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
  edge_target="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
  firefox_target="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
else
  chrome_targets="$HOME/.config/google-chrome/NativeMessagingHosts
$HOME/.config/chromium/NativeMessagingHosts"
  edge_target="$HOME/.config/microsoft-edge/NativeMessagingHosts"
  firefox_target="$HOME/.mozilla/native-messaging-hosts"
fi

if [ "$(uname -s)" = "Darwin" ]; then chrome_targets="$chrome_target"; fi
printf '%s\n' "$chrome_targets" | while IFS= read -r target; do
  [ -n "$target" ] || continue
  mkdir -p "$target"
  cp "$chrome_manifest" "$target/$host_name.json"
done
mkdir -p "$edge_target"
cp "$edge_manifest" "$edge_target/$host_name.json"
mkdir -p "$firefox_target"
cp "$firefox_manifest" "$firefox_target/$host_name.json"

echo "registered Firefox native host"
if [ -n "$chrome_id" ]; then
  echo "registered Chrome native host"
else
  echo "Chrome registration is staged but disabled until the store assigns an extension ID"
fi
if [ -n "$edge_id" ]; then
  echo "registered Edge native host"
elif [ -n "$chrome_id" ]; then
  echo "Edge registration is using the Chrome/development ID fallback; supply --edge-id before release"
else
  echo "Edge registration is staged but disabled until the store assigns an extension ID"
fi
