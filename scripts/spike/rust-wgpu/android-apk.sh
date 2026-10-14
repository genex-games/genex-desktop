#!/usr/bin/env bash
# M0a.16 spike only (M5.2 replaces it with the Android lane): package the pond on the Android
# shell (genex-platform-android, `examples/pond_android.rs` as `libmain.so`) as debug-signed APKs
# for both activity candidates M0a.12 chooses between.
#
#   bash scripts/spike/rust-wgpu/android-apk.sh --both-activities
#   bash scripts/spike/rust-wgpu/android-apk.sh --activity native|game [--manifest <file>]
#   bash scripts/spike/rust-wgpu/android-apk.sh --check-manifest <AndroidManifest.xml>
#   bash scripts/spike/rust-wgpu/android-apk.sh --check-so <lib.so>
#   bash scripts/spike/rust-wgpu/android-apk.sh --check-apk <file.apk>
#
# - The manifest (scripts/spike/rust-wgpu/android/AndroidManifest.xml, or --manifest <file>) is
#   checked before anything is built: minSdk >= 29 and the required
#   `android.hardware.vulkan.version` >= 0x401000 uses-feature (WebGPU core needs Vulkan 1.1).
# - The library is built through rust-env.sh (pinned sysroot, vendored crates, offline, locked,
#   NDK clang) for aarch64-linux-android with 16 KB page link args, and checked: AArch64 ELF,
#   every PT_LOAD aligned to 16 KB, DT_NEEDED within the plan's allow-list.
# - native: android.app.NativeActivity (no Java code; the JNI bridge reads the cutout).
#   game: GameActivity from games-activity 4.4.0. GameActivity extends AppCompatActivity, so its
#   AppCompat closure (appcompat 1.2.0, core 1.5.0, 23 AARs/jars, every sha256 pinned below and
#   checked against Google Maven's published checksums) is fetched once into the spike folder,
#   its resources linked by aapt2 and its classes dexed by d8 with the spike's JDK 21.
# - Packaging: aapt2 link (debug mode), the library stored uncompressed, `zipalign -P 16 4`,
#   `apksigner sign` with a fresh per-run debug key under the spike folder; then
#   `zipalign -c -P 16 4` and `apksigner verify` must pass.
# - Nothing is installed or launched: adb, the emulator and devices are the person's
#   (containment stage 1); `--install` is refused. The SDK is the installed one; no licence is
#   accepted. The plan pins NDK r30; the installed 27.x is used (recorded deviation).
#
# Outputs go to GENEX_MOBILE_OUT (default <repo>/.studio-dev/spike-mobile/out)/android/,
# evidence to <repo>/.studio-dev/evidence/m0a/m0a.16/android-<activity>.json.
# A refusal prints one typed line on stderr and exits 1:
#   genex-mobile: {"code":"<code>","detail":"<text>"}
# Written for the bash 3.2 macOS ships; functions start with `set -e` again (bash 3.2 clears
# errexit inside $(...)).

set -euo pipefail

MOBILE_REPO="$(cd -P "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
MOBILE_SPIKE="$MOBILE_REPO/scripts/spike/rust-wgpu"
MOBILE_OUT="${GENEX_MOBILE_OUT:-$MOBILE_REPO/.studio-dev/spike-mobile/out}"
MOBILE_WORK="${GENEX_MOBILE_WORK:-$MOBILE_REPO/.studio-dev/spike-mobile}"
MOBILE_EVIDENCE="${GENEX_MOBILE_EVIDENCE:-$MOBILE_REPO/.studio-dev/evidence/m0a/m0a.16}"
MOBILE_JDK="${GENEX_SPIKE_TOOLCHAIN_DIR:-$MOBILE_REPO/.studio-dev/spike-toolchain}/tools/jdk/Contents/Home"
MOBILE_FAIL_EXIT=1
MOBILE_MIN_FREE_GB=5

ANDROID_SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ANDROID_TARGET="aarch64-linux-android"
ANDROID_ABI="arm64-v8a"
ANDROID_MIN_SDK=29
ANDROID_COMPILE_SDK=35
# 0x401000 = VK_MAKE_API_VERSION(0, 1, 1, 0): Vulkan 1.1, the WebGPU-core floor on Android.
ANDROID_VULKAN_VERSION=4198400
ANDROID_PAGE_BYTES=16384
ANDROID_ZIP_ALIGN=4
ANDROID_LINK_ARGS="-C link-arg=-Wl,-z,max-page-size=$ANDROID_PAGE_BYTES -C link-arg=-Wl,-z,common-page-size=$ANDROID_PAGE_BYTES"
# Plan "Sandbox, admission and export per destination", Android row.
ANDROID_NEEDED_ALLOWED=" libandroid.so liblog.so libvulkan.so libaaudio.so libc.so libm.so libdl.so "
ANDROID_PACKAGE="genex-platform-android"
ANDROID_EXAMPLE="pond_android"
ANDROID_TEMPLATE="$MOBILE_SPIKE/android/AndroidManifest.xml"
ANDROID_APP_ID="games.genex.spike.pond"
GOOGLE_MAVEN="https://dl.google.com/android/maven2"
# The debug key: a throwaway made per run (Android's debug-key convention for the passwords).
DEBUG_KEY_ALIAS="genexdebug"
DEBUG_KEY_PASS="android"
DEBUG_KEY_DAYS=30

# GameActivity's closure: group:artifact version packaging sha256 (each checked against Google
# Maven's published .sha1, and its .sha256 where published, when pinned on 2026-10-06).
GAME_ACTIVITY_MAVEN="
androidx.games:games-activity 4.4.0 aar 3a8b0887ac55a0a6ab56021ced7353a250539eac811278b74bccd8a5b678d9c9
androidx.activity:activity 1.0.0 aar d1bc9842455c2e534415d88c44df4d52413b478db9093a1ba36324f705f44c3d
androidx.annotation:annotation 1.2.0 jar 9029262bddce116e6d02be499e4afdba21f24c239087b76b3b57d7e98b490a36
androidx.appcompat:appcompat 1.2.0 aar 3d2131a55a61a777322e2126e0018011efa6339e53b44153eb651b16020cca70
androidx.appcompat:appcompat-resources 1.2.0 aar c470297c03ff3de1c3d15dacf0be0cae63abc10b52f021dd07ae28daa3100fe5
androidx.arch.core:core-common 2.1.0 jar fe1237bf029d063e7f29fe39aeaf73ef74c8b0a3658486fc29d3c54326653889
androidx.arch.core:core-runtime 2.0.0 aar 87e65fc767c712b437649c7cee2431ebb4bed6daef82e501d4125b3ed3f65f8e
androidx.collection:collection 1.1.0 jar 632a0e5407461de774409352940e292a291037724207a787820c77daf7d33b72
androidx.core:core 1.5.0 aar 2b279712795689069cfb63e48b3ab63c32a5649bdda44c482eb8f81ca1a72161
androidx.cursoradapter:cursoradapter 1.0.0 aar a81c8fe78815fa47df5b749deb52727ad11f9397da58b16017f4eb2c11e28564
androidx.customview:customview 1.0.0 aar 20e5b8f6526a34595a604f56718da81167c0b40a7a94a57daa355663f2594df2
androidx.drawerlayout:drawerlayout 1.0.0 aar 9402442cdc5a43cf62fb14f8cf98c63342d4d9d9b805c8033c6cf7e802749ac1
androidx.fragment:fragment 1.1.0 aar a14c8b8f2153f128e800fbd266a6beab1c283982a29ec570d2cc05d307d81496
androidx.interpolator:interpolator 1.0.0 aar 33193135a64fe21fa2c35eec6688f1a76e512606c0fc83dc1b689e37add7732a
androidx.lifecycle:lifecycle-common 2.1.0 jar 76db6be533bd730fb361c2feb12a2c26d9952824746847da82601ef81f082643
androidx.lifecycle:lifecycle-livedata 2.0.0 aar c82609ced8c498f0a701a30fb6771bb7480860daee84d82e0a81ee86edf7ba39
androidx.lifecycle:lifecycle-livedata-core 2.0.0 aar fde334ec7e22744c0f5bfe7caf1a84c9d717327044400577bdf9bd921ec4f7bc
androidx.lifecycle:lifecycle-runtime 2.1.0 aar e5173897b965e870651e83d9d5af1742d3f532d58863223a390ce3a194c8312b
androidx.lifecycle:lifecycle-viewmodel 2.1.0 aar ba55fb7ac1b2828d5327cda8acf7085d990b2b4c43ef336caa67686249b8523d
androidx.loader:loader 1.0.0 aar 11f735cb3b55c458d470bed9e25254375b518b4b1bad6926783a7026db0f5025
androidx.savedstate:savedstate 1.0.0 aar 2510a5619c37579c9ce1a04574faaf323cd0ffe2fc4e20fa8f8f01e5bb402e83
androidx.vectordrawable:vectordrawable 1.1.0 aar 46fd633ac01b49b7fcabc263bf098c5a8b9e9a69774d234edcca04fb02df8e26
androidx.vectordrawable:vectordrawable-animated 1.1.0 aar 76da2c502371d9c38054df5e2b248d00da87809ed058f3363eae87ce5e2403f8
androidx.versionedparcelable:versionedparcelable 1.1.1 aar 57e8d93260d18d5b9007c9eed3c64ad159de90c8609ebfc74a347cbd514535a4
androidx.viewpager:viewpager 1.0.0 aar 147af4e14a1984010d8f155e5e19d781f03c1d70dfed02a8e0d18428b8fc8682
"

mobile_json_escape() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\n'/ }
  s=${s//$'\t'/ }
  printf '%s' "$s"
}

# Print the typed refusal line and exit 1.
mobile_fail() {
  printf 'genex-mobile: {"code":"%s","detail":"%s"}\n' "$1" "$(mobile_json_escape "$2")" >&2
  exit "$MOBILE_FAIL_EXIT"
}

mobile_log() {
  printf 'android-apk: %s\n' "$*" >&2
}

usage() {
  mobile_fail usage "usage: android-apk.sh --both-activities | --activity native|game [--manifest <file>] | --check-manifest <file> | --check-so <lib.so> | --check-apk <file.apk>"
}

require_node() {
  command -v node >/dev/null 2>&1 || mobile_fail tool-missing "node is not on PATH (nvm use 24)"
}

# check_manifest <file>: minSdk and the required Vulkan 1.1 uses-feature. Prints nothing on success.
check_manifest() {
  set -e
  local verdict
  [ -f "$1" ] || mobile_fail manifest-missing "no AndroidManifest.xml at $1"
  require_node
  verdict=$(node -e '
    const [file, minSdk, vulkan] = process.argv.slice(1);
    const xml = require("node:fs").readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
    const attr = (tag, name) => (tag.match(new RegExp(`android:${name}\\s*=\\s*"([^"]*)"`)) ?? [])[1];
    const number = (text) => (text === undefined ? NaN : Number(text.trim()));
    const sdk = (xml.match(/<uses-sdk\b[^>]*>/) ?? [])[0];
    const min = sdk ? number(attr(sdk, "minSdkVersion")) : NaN;
    if (!(min >= Number(minSdk))) {
      console.log(`manifest-min-sdk\tminSdkVersion ${sdk ? attr(sdk, "minSdkVersion") : "missing"}, needs ${minSdk} or later`);
      process.exit(0);
    }
    const features = xml.match(/<uses-feature\b[^>]*>/g) ?? [];
    const feature = features.find((tag) => attr(tag, "name") === "android.hardware.vulkan.version");
    if (!feature) {
      console.log("manifest-vulkan-feature\tno android.hardware.vulkan.version uses-feature");
      process.exit(0);
    }
    const version = number(attr(feature, "version"));
    if (!(version >= Number(vulkan))) {
      console.log(`manifest-vulkan-feature\tandroid.hardware.vulkan.version ${attr(feature, "version")}, needs 0x401000 (Vulkan 1.1)`);
      process.exit(0);
    }
    if (attr(feature, "required") === "false") {
      console.log("manifest-vulkan-feature\tthe Vulkan uses-feature must be required (WebGPU core has no GLES tier)");
    }
  ' "$1" "$ANDROID_MIN_SDK" "$ANDROID_VULKAN_VERSION")
  [ -z "$verdict" ] || mobile_fail "${verdict%%$'\t'*}" "$1: ${verdict#*$'\t'}"
}

# check_so <file>: AArch64 ELF, every PT_LOAD aligned to 16 KB, DT_NEEDED allow-listed.
check_so() {
  set -e
  local verdict
  [ -f "$1" ] || mobile_fail so-missing "no library at $1"
  require_node
  verdict=$(node -e '
    const [file, page, allowed] = process.argv.slice(1);
    const b = require("node:fs").readFileSync(file);
    const isElf64 = b.length >= 64 && b.toString("latin1", 0, 4) === "\x7fELF" && b[4] === 2 && b[5] === 1;
    if (!isElf64 || b.readUInt16LE(18) !== 183) {
      console.log("so-not-aarch64\tnot a little-endian ELF64 AArch64 file");
      process.exit(0);
    }
    const phoff = Number(b.readBigUInt64LE(32));
    const phentsize = b.readUInt16LE(54);
    const phnum = b.readUInt16LE(56);
    const loads = [];
    let dynamic = null;
    for (let i = 0; i < phnum; i++) {
      const at = phoff + i * phentsize;
      if (at + 56 > b.length) break;
      const type = b.readUInt32LE(at);
      if (type === 1) loads.push(Number(b.readBigUInt64LE(at + 48)));
      if (type === 2) dynamic = { offset: Number(b.readBigUInt64LE(at + 8)), size: Number(b.readBigUInt64LE(at + 32)) };
    }
    if (loads.length === 0) {
      console.log("so-not-16k\tno PT_LOAD segment");
      process.exit(0);
    }
    const small = loads.find((align) => align < Number(page));
    if (small !== undefined) {
      console.log(`so-not-16k\ta PT_LOAD is aligned to ${small} bytes, not ${page}`);
      process.exit(0);
    }
    if (dynamic === null) process.exit(0);
    // DT_NEEDED names live in DT_STRTAB, addressed by vaddr: map it through the PT_LOADs.
    const segs = [];
    for (let i = 0; i < phnum; i++) {
      const at = phoff + i * phentsize;
      if (b.readUInt32LE(at) !== 1) continue;
      segs.push({ off: Number(b.readBigUInt64LE(at + 8)), vaddr: Number(b.readBigUInt64LE(at + 16)), size: Number(b.readBigUInt64LE(at + 32)) });
    }
    const toOffset = (vaddr) => {
      const seg = segs.find((s) => vaddr >= s.vaddr && vaddr < s.vaddr + s.size);
      return seg ? vaddr - seg.vaddr + seg.off : -1;
    };
    const needed = [];
    let strtab = -1;
    for (let at = dynamic.offset; at + 16 <= dynamic.offset + dynamic.size; at += 16) {
      const tag = Number(b.readBigInt64LE(at));
      const value = Number(b.readBigUInt64LE(at + 8));
      if (tag === 0) break;
      if (tag === 1) needed.push(value);
      if (tag === 5) strtab = toOffset(value);
    }
    for (const index of needed) {
      if (strtab < 0) break;
      const start = strtab + index;
      const name = b.toString("latin1", start, b.indexOf(0, start));
      if (!allowed.includes(` ${name} `)) {
        console.log(`so-needed-not-allowed\tneeds ${name}`);
        process.exit(0);
      }
    }
  ' "$1" "$ANDROID_PAGE_BYTES" "$ANDROID_NEEDED_ALLOWED")
  [ -z "$verdict" ] || mobile_fail "${verdict%%$'\t'*}" "$1: ${verdict#*$'\t'}"
}

# The newest installed build-tools folder with zipalign -P support (35+).
build_tools() {
  set -e
  local dir="$ANDROID_SDK/build-tools" found="" v
  [ -d "$dir" ] || mobile_fail tool-missing "no Android build-tools under $ANDROID_SDK (the SDK is the person's install)"
  for v in $(ls "$dir" | sort -t. -k1,1n -k2,2n -k3,3n); do
    case $v in 3[5-9].* | [4-9][0-9].*) [ -x "$dir/$v/zipalign" ] && found="$dir/$v" ;; esac
  done
  [ -n "$found" ] || mobile_fail tool-missing "no build-tools 35 or later (zipalign -P) under $dir"
  printf '%s\n' "$found"
}

require_java() {
  [ -x "$MOBILE_JDK/bin/java" ] || mobile_fail tool-missing "no spike JDK at $MOBILE_JDK (setup-toolchain.sh installs Temurin 21)"
  export JAVA_HOME="$MOBILE_JDK"
  export PATH="$JAVA_HOME/bin:$PATH"
}

# check_apk <apk>: every library 16 KB aligned and stored, zip-aligned with -P 16, signed.
check_apk() {
  set -e
  local apk=$1 tools tmp lib libs info
  [ -f "$apk" ] || mobile_fail apk-missing "no APK at $apk"
  tools=$(build_tools)
  require_java
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/genex-apk-check.XXXXXX")
  libs=$(unzip -Z1 "$apk" 'lib/*.so' 2>/dev/null || true)
  for lib in $libs; do
    unzip -p "$apk" "$lib" >"$tmp/lib.so"
    check_so "$tmp/lib.so"
    # Not `unzip | grep -q`: under pipefail grep's early exit would SIGPIPE unzip.
    info=$(unzip -Zv "$apk" "$lib")
    case $info in *"compression method:"*"none (stored)"*) ;; *) false ;; esac ||
      mobile_fail so-compressed "$apk: $lib is compressed (extractNativeLibs false needs it stored)"
  done
  rm -f "$tmp/lib.so"
  rmdir "$tmp"
  "$tools/zipalign" -c -P 16 "$ANDROID_ZIP_ALIGN" "$apk" >/dev/null 2>&1 ||
    mobile_fail apk-not-aligned "$apk does not pass zipalign -c -P 16 $ANDROID_ZIP_ALIGN"
  "$tools/apksigner" verify --min-sdk-version "$ANDROID_MIN_SDK" "$apk" >/dev/null 2>&1 ||
    mobile_fail apk-unsigned "$apk does not pass apksigner verify"
}

require_disk() {
  set -e
  local free
  free=$(df -g "$MOBILE_REPO" | awk 'NR == 2 { print $4 }')
  [ "$free" -ge "$MOBILE_MIN_FREE_GB" ] ||
    mobile_fail disk "$free GB free, an Android build needs $MOBILE_MIN_FREE_GB GB (cargo clean the shared target first)"
}

# fetch_maven <dir>: the GameActivity closure, each file checked against its pinned sha256.
fetch_maven() {
  set -e
  local dir=$1 ga version kind sha group artifact file url got
  mkdir -p "$dir"
  while read -r ga version kind sha; do
    [ -n "$ga" ] || continue
    group=${ga%%:*}
    artifact=${ga##*:}
    file="$dir/$artifact-$version.$kind"
    if [ ! -f "$file" ]; then
      url="$GOOGLE_MAVEN/$(printf '%s' "$group" | tr . /)/$artifact/$version/$artifact-$version.$kind"
      mobile_log "fetching $url"
      curl -sS -f -L --proto '=https' -m 120 -o "$file.partial" "$url" || mobile_fail fetch-failed "$url"
      mv "$file.partial" "$file"
    fi
    got=$(shasum -a 256 "$file" | awk '{ print $1 }')
    if [ "$got" != "$sha" ]; then
      rm -f "$file"
      mobile_fail sha256-mismatch "$ga:$version: got $got, pinned $sha"
    fi
  done <<EOF
$GAME_ACTIVITY_MAVEN
EOF
}

# example_library <log>: the .so Cargo reported for the cdylib example in <log> (cross-lib.sh's
# cross_artifact reads `executable`, which a cdylib example does not have).
example_library() {
  set -e
  local found
  require_node
  found=$(node -e '
    const [log, name] = process.argv.slice(1);
    let hit = "";
    for (const line of require("node:fs").readFileSync(log, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      const m = JSON.parse(line);
      if (m.reason !== "compiler-artifact" || m.target.name !== name) continue;
      hit = m.filenames.find((f) => f.endsWith(".so")) ?? hit;
    }
    process.stdout.write(hit);
  ' "$1" "$ANDROID_EXAMPLE")
  [ -n "$found" ] && [ -f "$found" ] || mobile_fail no-artifact "cargo reported no $ANDROID_EXAMPLE library in $1"
  printf '%s\n' "$found"
}

# build_lib <native|game> <stage dir>: libmain.so for the activity, checked.
build_lib() {
  set -e
  local activity=$1 stage=$2 log ms so features=""
  [ "$activity" = game ] && features="--no-default-features --features game-activity"
  # shellcheck source=cross-lib.sh
  . "$MOBILE_SPIKE/cross-lib.sh"
  CROSS_NAME=android-apk
  export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="$ANDROID_LINK_ARGS"
  log="$MOBILE_EVIDENCE/android-$activity-build.jsonl"
  mobile_log "building $ANDROID_EXAMPLE ($activity activity) for $ANDROID_TARGET"
  # shellcheck disable=SC2086 # $features is one or three words
  ms=$(cross_cargo "$log" build -p "$ANDROID_PACKAGE" --example "$ANDROID_EXAMPLE" --release --target "$ANDROID_TARGET" --offline --locked $features)
  so=$(example_library "$log")
  mkdir -p "$stage/lib/$ANDROID_ABI"
  cp -f "$so" "$stage/lib/$ANDROID_ABI/libmain.so"
  check_so "$stage/lib/$ANDROID_ABI/libmain.so"
  printf '%s\n' "$ms"
}

# render_manifest <native|game> <template> <out>
render_manifest() {
  set -e
  local activity=$1 template=$2 out=$3 class has_code theme
  case $activity in
    native) class=android.app.NativeActivity has_code=false theme='@android:style/Theme.NoTitleBar.Fullscreen' ;;
    game) class=com.google.androidgamesdk.GameActivity has_code=true theme='@style/Theme.AppCompat.NoActionBar' ;;
  esac
  sed -e "s|@PACKAGE@|$ANDROID_APP_ID.$activity|" -e "s|@HAS_CODE@|$has_code|" -e "s|@THEME@|$theme|" \
    -e "s|@ACTIVITY@|$class|" "$template" >"$out"
  check_manifest "$out"
}

# link_game_code <work> <tools> <base.apk> <manifest>: AppCompat resources, R classes and dex.
link_game_code() {
  set -e
  local work=$1 tools=$2 base=$3 manifest=$4 maven="$MOBILE_WORK/maven" file name pkgs="" res_args=() jars=()
  local android_jar="$ANDROID_SDK/platforms/android-$ANDROID_COMPILE_SDK/android.jar"
  [ -f "$android_jar" ] || mobile_fail tool-missing "no $android_jar (platform android-$ANDROID_COMPILE_SDK)"
  fetch_maven "$maven"
  mkdir -p "$work/aar" "$work/res" "$work/gen" "$work/classes" "$work/dex"
  for file in "$maven"/*; do
    name=$(basename "$file")
    case $name in
      *.jar) jars+=("$file") ;;
      *.aar)
        name=${name%.aar}
        unzip -q -o "$file" -d "$work/aar/$name"
        [ -f "$work/aar/$name/classes.jar" ] && jars+=("$work/aar/$name/classes.jar")
        if [ -d "$work/aar/$name/libs" ]; then
          for file in "$work/aar/$name/libs"/*.jar; do [ -f "$file" ] && jars+=("$file"); done
        fi
        pkgs="$pkgs:$(sed -n 's/.*package="\([^"]*\)".*/\1/p' "$work/aar/$name/AndroidManifest.xml" | head -1)"
        if [ -d "$work/aar/$name/res" ] && [ -n "$(ls -A "$work/aar/$name/res")" ]; then
          "$tools/aapt2" compile --dir "$work/aar/$name/res" -o "$work/res/$name.zip" ||
            mobile_fail aapt2-failed "aapt2 compile of $name"
          res_args+=(-R "$work/res/$name.zip")
        fi
        ;;
    esac
  done
  "$tools/aapt2" link -o "$base" -I "$android_jar" --manifest "$manifest" --debug-mode --auto-add-overlay \
    --min-sdk-version "$ANDROID_MIN_SDK" --java "$work/gen" --extra-packages "${pkgs#:}" "${res_args[@]}" ||
    mobile_fail aapt2-failed "aapt2 link of the GameActivity APK"
  find "$work/gen" -name '*.java' >"$work/sources.txt"
  "$JAVA_HOME/bin/javac" -nowarn --release 11 -classpath "$android_jar" -d "$work/classes" "@$work/sources.txt" ||
    mobile_fail javac-failed "javac of the generated R classes"
  (cd "$work/classes" && "$JAVA_HOME/bin/jar" cf "$work/r.jar" .)
  "$tools/d8" --release --min-api "$ANDROID_MIN_SDK" --lib "$android_jar" --output "$work/dex" "$work/r.jar" "${jars[@]}" ||
    mobile_fail d8-failed "d8 of the GameActivity closure"
  (cd "$work/dex" && zip -q -X "$base" classes*.dex)
}

# package <native|game> <manifest template>: one checked, debug-signed APK.
package() {
  set -e
  local activity=$1 template=$2 tools work stage base aligned apk ms key android_jar
  tools=$(build_tools)
  require_java
  android_jar="$ANDROID_SDK/platforms/android-$ANDROID_COMPILE_SDK/android.jar"
  [ -f "$android_jar" ] || mobile_fail tool-missing "no $android_jar (platform android-$ANDROID_COMPILE_SDK)"
  require_disk
  work="$MOBILE_WORK/android/$activity"
  rm -rf "$work"
  mkdir -p "$work"
  stage="$work/stage"
  render_manifest "$activity" "$template" "$work/AndroidManifest.xml"
  ms=$(build_lib "$activity" "$stage")
  base="$work/base.apk"
  if [ "$activity" = game ]; then
    link_game_code "$work" "$tools" "$base" "$work/AndroidManifest.xml"
  else
    "$tools/aapt2" link -o "$base" -I "$android_jar" --manifest "$work/AndroidManifest.xml" --debug-mode \
      --min-sdk-version "$ANDROID_MIN_SDK" || mobile_fail aapt2-failed "aapt2 link of the NativeActivity APK"
  fi
  # Libraries go in stored (extractNativeLibs false loads them in place, page aligned).
  (cd "$stage" && zip -q -X -0 -r "$base" lib)
  aligned="$work/aligned.apk"
  "$tools/zipalign" -P 16 -f "$ANDROID_ZIP_ALIGN" "$base" "$aligned" || mobile_fail zipalign-failed "zipalign -P 16 of $base"
  key="$work/debug.keystore"
  "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$key" -storetype PKCS12 -alias "$DEBUG_KEY_ALIAS" \
    -storepass "$DEBUG_KEY_PASS" -keypass "$DEBUG_KEY_PASS" -keyalg RSA -keysize 2048 -validity "$DEBUG_KEY_DAYS" \
    -dname "CN=Genex Spike Debug" -noprompt >/dev/null 2>&1 || mobile_fail keytool-failed "debug key in $key"
  mkdir -p "$MOBILE_OUT/android"
  apk="$MOBILE_OUT/android/pond-$activity-activity-debug.apk"
  rm -f "$apk"
  "$tools/apksigner" sign --ks "$key" --ks-key-alias "$DEBUG_KEY_ALIAS" --ks-pass "pass:$DEBUG_KEY_PASS" \
    --key-pass "pass:$DEBUG_KEY_PASS" --min-sdk-version "$ANDROID_MIN_SDK" --out "$apk" "$aligned" ||
    mobile_fail sign-failed "apksigner sign of $aligned"
  rm -f "$apk.idsig"
  check_apk "$apk"
  write_record "$activity" "$apk" "$ms" "$tools"
}

write_record() {
  set -e
  local activity=$1 apk=$2 ms=$3 tools=$4 ndk
  ndk=$(bash "$MOBILE_SPIKE/rust-env.sh" --print-env | awk -F= '/^export ANDROID_NDK_HOME=/ { print $2 }')
  mkdir -p "$MOBILE_EVIDENCE"
  printf '{"format":"genex-mobile/1","destination":"android","activity":"%s","package":"%s","apk":"%s","bytes":%s,"sha256":"%s","minSdk":%s,"vulkanVersion":"0x401000","pageBytes":%s,"zipalignChecked":true,"apksignerVerified":true,"debugKey":"per-run","buildTools":"%s","ndk":"%s","buildMs":%s,"installed":false,"next":"person: adb install %s (M0a.12)"}\n' \
    "$activity" "$ANDROID_APP_ID.$activity" "$(mobile_json_escape "$apk")" "$(wc -c <"$apk" | tr -d ' ')" \
    "$(shasum -a 256 "$apk" | awk '{ print $1 }')" "$ANDROID_MIN_SDK" "$ANDROID_PAGE_BYTES" "$(basename "$tools")" \
    "$(mobile_json_escape "$(basename "$ndk")")" "$ms" "$(mobile_json_escape "$apk")" >"$MOBILE_EVIDENCE/android-$activity.json"
  mobile_log "ready: $apk (record $MOBILE_EVIDENCE/android-$activity.json)"
}

main() {
  local activities="" manifest="$ANDROID_TEMPLATE" activity
  [ $# -gt 0 ] || usage
  while [ $# -gt 0 ]; do
    case $1 in
      --both-activities) activities="native game" ;;
      --activity)
        [ $# -ge 2 ] || usage
        case $2 in native | game) activities="$activities $2" ;; *) usage ;; esac
        shift
        ;;
      --manifest)
        [ $# -ge 2 ] || usage
        manifest=$2
        shift
        ;;
      --install | --boot | --launch | --emulator) mobile_fail boot-not-allowed "$1: adb, the emulator and devices are the person's, never this script's" ;;
      --check-manifest | --check-so | --check-apk)
        [ $# -ge 2 ] || usage
        case $1 in
          --check-manifest) check_manifest "$2" ;;
          --check-so) check_so "$2" ;;
          --check-apk) check_apk "$2" ;;
        esac
        return 0
        ;;
      *) usage ;;
    esac
    shift
  done
  [ -n "$activities" ] || usage
  # Every check that needs no build runs before any build.
  check_manifest "$manifest"
  for activity in $activities; do package "$activity" "$manifest"; done
}

main "$@"
