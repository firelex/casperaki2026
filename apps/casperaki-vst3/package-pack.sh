#!/usr/bin/env bash
# docs/65 — package the built Casperaki VST3s into ONE installer the producer
# installs ONCE. After that, every per-song casperaki.zip (edit-vst3.trkedit +
# samples) opens in Tracktion/Waveform with all Casperaki FX resolving by uid.
#
#   cmake --build build           # build the .vst3 first
#   bash package-pack.sh          # -> dist/casperaki-vst3-pack.zip
set -euo pipefail
cd "$(dirname "$0")"

BUILD="${1:-build}"
STAGE="dist/CasperakiVST3"
OUT="dist/casperaki-vst3-pack.zip"
rm -rf "$STAGE"; mkdir -p "$STAGE"

n=0
while IFS= read -r -d '' vst3; do
  cp -r "$vst3" "$STAGE/"; n=$((n+1))
done < <(find "$BUILD" -name '*.vst3' -type d -path '*VST3*' -print0)
echo "[pack] staged $n .vst3 bundles"

cat > "$STAGE/INSTALL.md" <<'MD'
# Casperaki VST3 plugins — install once

These are the Casperaki-custom effects used in the exported Tracktion edits
(FreqShiftEcho, SimpleSide, and the AirWindows extras: Console8 in/out buss/sub,
kPlateD/A, TexturizeMS, StereoChorus, Huge, Air2). Install them ONCE, then every
per-song `edit.trkedit` you receive will resolve them automatically (Tracktion
matches plugins by their stable id, regardless of where you install them).

## Install
- **Linux:**   copy the `*.vst3` folders into `~/.vst3/`
- **macOS:**   copy them into `~/Library/Audio/Plug-Ins/VST3/`
- **Windows:** copy them into `C:\Program Files\Common Files\VST3\`

Then rescan plugins in your DAW (Waveform: Settings → Plugins → Scan/Rescan).

## Open a song
Unzip a per-song `casperaki.zip` and open the `edit.trkedit` inside it. The
samples travel in the same zip; the Casperaki FX resolve to the plugins you
installed above. (Stock Tracktion AirWindows — EQ, Logical4, Pyewacket, etc. —
ship with Waveform and need no install.)
MD

cat > "$STAGE/install.sh" <<'SH'
#!/usr/bin/env bash
# Copies the bundled *.vst3 into the user VST3 folder for this OS.
set -euo pipefail
cd "$(dirname "$0")"
case "$(uname -s)" in
  Linux)  DEST="$HOME/.vst3" ;;
  Darwin) DEST="$HOME/Library/Audio/Plug-Ins/VST3" ;;
  *)      echo "Unsupported OS; copy the *.vst3 folders into your VST3 dir manually."; exit 1 ;;
esac
mkdir -p "$DEST"
for v in *.vst3; do cp -r "$v" "$DEST/"; echo "installed $v -> $DEST"; done
echo "Done. Rescan plugins in your DAW."
SH
chmod +x "$STAGE/install.sh"

( cd dist && python3 -c "
import zipfile, os
z = zipfile.ZipFile('casperaki-vst3-pack.zip', 'w', zipfile.ZIP_DEFLATED)
for root, _, files in os.walk('CasperakiVST3'):
    for f in files:
        p = os.path.join(root, f)
        z.write(p, p)
z.close()
print('[pack] wrote', os.path.getsize('casperaki-vst3-pack.zip')//1024, 'KiB')
" )
echo "[pack] -> $OUT"
