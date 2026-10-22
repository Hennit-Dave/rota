#!/usr/bin/env python3
"""Checks that an Android APK works with 16 KB memory pages.

Usage: python3 scripts/check-16kb.py path/to/app.apk

Two checks, both required by docs/decisions/0011:
  1. zipalign -c -P 16 -v 4   (uncompressed native libraries start on 16 KB boundaries inside the zip)
  2. every 64-bit .so in the APK has every LOAD segment aligned to at least 0x4000 (16 KB)
Exit code 0 only if both pass. Needs the Android SDK build-tools (zipalign), found through ANDROID_HOME or ~/Library/Android/sdk.
Standard library only.
"""
import glob
import os
import struct
import subprocess
import sys
import zipfile

MIN_ALIGN = 0x4000
EM_AARCH64, EM_X86_64 = 183, 62


def find_zipalign():
    roots = [os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT"), os.path.expanduser("~/Library/Android/sdk"), os.path.expanduser("~/Android/Sdk")]
    for root in filter(None, roots):
        found = sorted(glob.glob(os.path.join(root, "build-tools", "*", "zipalign")))
        if found:
            return found[-1]
    return None


def load_alignments(data):
    """Returns (machine, [p_align of every LOAD segment]) for a 64-bit little-endian ELF, else None."""
    if data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
        return None
    machine = struct.unpack_from("<H", data, 18)[0]
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phentsize, phnum = struct.unpack_from("<HH", data, 54)
    aligns = []
    for i in range(phnum):
        off = phoff + i * phentsize
        if struct.unpack_from("<I", data, off)[0] == 1:  # PT_LOAD
            aligns.append(struct.unpack_from("<Q", data, off + 48)[0])
    return machine, aligns


def main():
    if len(sys.argv) != 2 or not os.path.isfile(sys.argv[1]):
        print(__doc__)
        return 2
    apk = sys.argv[1]
    ok = True

    zipalign = find_zipalign()
    if zipalign is None:
        print("FAIL zipalign not found (set ANDROID_HOME)")
        ok = False
    else:
        result = subprocess.run([zipalign, "-c", "-P", "16", "-v", "4", apk], capture_output=True, text=True)
        verdict = "passed" if result.returncode == 0 else "FAILED"
        print(f"zipalign -c -P 16: {verdict}")
        if result.returncode != 0:
            ok = False
            print("\n".join(l for l in result.stdout.splitlines() if "(OK" not in l)[:2000])

    checked = bad = 0
    with zipfile.ZipFile(apk) as z:
        for name in sorted(n for n in z.namelist() if n.endswith(".so")):
            info = load_alignments(z.read(name))
            if info is None:
                continue
            machine, aligns = info
            if machine not in (EM_AARCH64, EM_X86_64):
                continue
            checked += 1
            if not aligns or min(aligns) < MIN_ALIGN:
                bad += 1
                print(f"BAD  {name}  LOAD alignments: {[hex(a) for a in aligns]}")
    print(f"64-bit native libraries checked: {checked}, not 16 KB aligned: {bad}")
    if checked == 0:
        print("FAIL no 64-bit libraries found")
        ok = False
    if bad:
        ok = False
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
