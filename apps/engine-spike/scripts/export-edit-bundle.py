#!/usr/bin/env python3
# docs/65 — bundle a rendered Tracktion edit + its referenced samples into a
# standalone, producer-openable casperaki.zip (the legacy export artifact).
#
# The engine's CasperakiEngine::createZipFile() zips only the edit FOLDER, but in
# the spike the samples are staged in that folder's PARENT (the edit references
# them as source="../playsample-N.ogg" / "./../vstsample-N.ogg"), so the legacy
# zip would miss them. This resolves every `source` ref against the edit dir and
# adds each referenced sample to the zip at its path relative to the edit-folder
# PARENT — preserving the exact relative layout so the `../` links resolve when a
# producer extracts and opens edit.trkedit in Waveform/Tracktion.
#
# Usage: export-edit-bundle.py <edit.trkedit> <out.zip>
import os, sys, zipfile
import xml.etree.ElementTree as ET

if len(sys.argv) != 3:
    sys.exit("usage: export-edit-bundle.py <edit.trkedit> <out.zip>")

edit_path = os.path.abspath(sys.argv[1])
out_zip = os.path.abspath(sys.argv[2])
edit_dir = os.path.dirname(edit_path)        # .../Temporary/casperaki
parent = os.path.dirname(edit_dir)           # .../Temporary  (zip root)
# Always present the edit as <dir>/edit.trkedit in the zip (the source may be
# edit-vst3.trkedit) so the producer just opens edit.trkedit.
edit_arc = os.path.relpath(os.path.join(edit_dir, "edit.trkedit"), parent)

# Parse the trkedit as XML and collect every `source` attribute (any
# extension). ElementTree unescapes XML entities automatically, so a path
# containing &amp; resolves to the real on-disk name rather than a false miss.
root = ET.parse(edit_path).getroot()
refs = [el.get("source") for el in root.iter() if el.get("source")]

added, missing, unsafe = {}, [], []
for r in dict.fromkeys(refs):                # de-dup, keep order
    real = os.path.normpath(os.path.join(edit_dir, r))
    arc = os.path.relpath(real, parent)
    # Reject arcnames that escape the zip root (absolute or ../ prefixed).
    if os.path.isabs(arc) or arc == os.pardir or arc.startswith(os.pardir + os.sep):
        unsafe.append(r)
        continue
    if arc in added:
        continue
    if os.path.exists(real):
        added[arc] = real
    else:
        missing.append(r)

os.makedirs(os.path.dirname(out_zip), exist_ok=True)
with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
    z.write(edit_path, edit_arc)
    for arc, real in added.items():
        z.write(real, arc)

size = os.path.getsize(out_zip)
print(f"[bundle] {out_zip}  ({size//1024} KiB): {edit_arc} + {len(added)} samples"
      + (f", {len(missing)} MISSING" if missing else "")
      + (f", {len(unsafe)} UNSAFE" if unsafe else ""))
if unsafe:
    print("  unsafe (escaped zip root, skipped):",
          ", ".join(unsafe[:10]) + (" ..." if len(unsafe) > 10 else ""))
if missing:
    print("  missing:", ", ".join(missing[:10]) + (" ..." if len(missing) > 10 else ""))
if missing or unsafe:
    sys.exit(2)
