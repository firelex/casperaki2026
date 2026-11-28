#!/bin/sh
# Installs what the avatar builder needs into the Blender in ~/apps/blender (from ~/apps/blender/downloads, fetched by
# ~/apps/blender/get-blender.sh and get-makehuman.sh plus the community packs): the MPFB (MakeHuman) and VRM add-ons,
# then every asset pack unzipped into MPFB's data folder. Existing files are kept. Re-run after adding packs, then
# regenerate library.json (tools/make_library.py).
set -eu
B="$HOME/apps/blender"
BLENDER="$B/blender-4.5.17-linux-x64/blender"
D="$B/downloads"
DATA="$HOME/.config/blender/4.5/extensions/.user/user_default/mpfb/data"
"$BLENDER" -b --command extension install-file -r user_default -e "$D/mpfb-2.0.18.zip"
"$BLENDER" -b --command extension install-file -r user_default -e "$D/vrm-4.10.5.zip"
mkdir -p "$DATA"
for z in "$D"/*.zip "$D"/community/*.zip; do
  case "$(basename "$z")" in mpfb-*|vrm-*) continue ;; esac
  unzip -n -q "$z" -d "$DATA"
done
echo "avatar builder assets installed into $DATA"
