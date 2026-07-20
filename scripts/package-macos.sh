#!/usr/bin/env bash
# Build Bay Host.app + Bay Connect.app (darwin-arm64) with bundled Node.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${BAY_PKG_ARCH:-arm64}"
NODE_VERSION="${BAY_NODE_VERSION:-22.14.0}"
VERSION="${BAY_APP_VERSION:-0.1.0}"
DIST="$ROOT/dist/macos"
CACHE="$ROOT/dist/cache"
STAGE="$ROOT/dist/stage-macos"
NODE_DIST="node-v${NODE_VERSION}-darwin-${ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.gz"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "package-macos.sh must run on macOS" >&2
  exit 1
fi
if [[ "$(uname -m)" == "x86_64" && "$ARCH" == "arm64" ]]; then
  echo "Warning: building arm64 apps on Intel — ensure you have an arm64 Swift toolchain." >&2
fi

echo "==> Building @bay/shared"
cd "$ROOT"
pnpm --filter @bay/shared build

rm -rf "$STAGE" "$DIST"
mkdir -p "$CACHE" "$DIST" "$STAGE"

echo "==> Fetching Node ${NODE_VERSION} (${ARCH})"
NODE_TGZ="$CACHE/${NODE_DIST}.tar.gz"
if [[ ! -f "$NODE_TGZ" ]]; then
  curl -fsSL "$NODE_URL" -o "$NODE_TGZ"
fi
rm -rf "$CACHE/$NODE_DIST"
tar -xzf "$NODE_TGZ" -C "$CACHE"

stage_node_modules_host() {
  local dest="$1"
  mkdir -p "$dest"
  # Isolated install: file: dependency on built shared + prod deps.
  cat >"$dest/package.json" <<EOF
{
  "name": "@bay/host-bundle",
  "private": true,
  "type": "module",
  "dependencies": {
    "@bay/shared": "file:./vendor/shared",
    "@hono/node-server": "^1.14.1",
    "hono": "^4.7.5"
  }
}
EOF
  mkdir -p "$dest/vendor/shared"
  cp "$ROOT/packages/shared/package.json" "$dest/vendor/shared/"
  cp -R "$ROOT/packages/shared/dist" "$dest/vendor/shared/dist"
  # shared package.json points main at ./dist — good
  (cd "$dest" && npm install --omit=dev --install-links --no-fund --no-audit --no-progress)
  # Ensure @bay/shared is a real directory (not a broken symlink to vendor/)
  rm -rf "$dest/node_modules/@bay/shared"
  mkdir -p "$dest/node_modules/@bay/shared"
  cp "$ROOT/packages/shared/package.json" "$dest/node_modules/@bay/shared/"
  cp -R "$ROOT/packages/shared/dist" "$dest/node_modules/@bay/shared/dist"
  rm -rf "$dest/vendor"
  # Copy app sources after install so they aren't wiped
  mkdir -p "$dest/src" "$dest/guest"
  cp -R "$ROOT/host/src/"* "$dest/src/"
  if [[ -d "$ROOT/host/guest" ]]; then
    cp -R "$ROOT/host/guest/"* "$dest/guest/" 2>/dev/null || true
  fi
  # Remove npm metadata we don't need at runtime
  rm -f "$dest/package-lock.json"
}

stage_node_modules_connect() {
  local dest="$1"
  mkdir -p "$dest"
  cat >"$dest/package.json" <<EOF
{
  "name": "@bay/connect-bundle",
  "private": true,
  "type": "module",
  "dependencies": {
    "@bay/shared": "file:./vendor/shared"
  }
}
EOF
  mkdir -p "$dest/vendor/shared"
  cp "$ROOT/packages/shared/package.json" "$dest/vendor/shared/"
  cp -R "$ROOT/packages/shared/dist" "$dest/vendor/shared/dist"
  (cd "$dest" && npm install --omit=dev --install-links --no-fund --no-audit --no-progress)
  rm -rf "$dest/node_modules/@bay/shared"
  mkdir -p "$dest/node_modules/@bay/shared"
  cp "$ROOT/packages/shared/package.json" "$dest/node_modules/@bay/shared/"
  cp -R "$ROOT/packages/shared/dist" "$dest/node_modules/@bay/shared/dist"
  rm -rf "$dest/vendor"
  mkdir -p "$dest/src"
  cp -R "$ROOT/connect/src/"* "$dest/src/"
  rm -f "$dest/package-lock.json"
}

build_app() {
  local name="$1"   # "Bay Host" | "Bay Connect"
  local kind="$2"   # host | connect
  local app="$STAGE/${name}.app"
  local contents="$app/Contents"
  local macos_dir="$contents/MacOS"
  local resources="$contents/Resources"

  mkdir -p "$macos_dir" "$resources"

  cp "$ROOT/packaging/macos/${kind}/Info.plist" "$contents/Info.plist"
  # bump version in plist
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $VERSION" "$contents/Info.plist" 2>/dev/null || true

  echo "==> Compiling ${name} launcher"
  swiftc -O -framework AppKit -framework Foundation \
    -o "$macos_dir/${name}" \
    "$ROOT/packaging/macos/${kind}/Launcher.swift"
  chmod +x "$macos_dir/${name}"

  echo "==> Bundling Node + ${kind} app"
  mkdir -p "$resources/node"
  cp -R "$CACHE/$NODE_DIST/"* "$resources/node/"
  chmod +x "$resources/node/bin/node"

  if [[ "$kind" == "host" ]]; then
    stage_node_modules_host "$resources/app"
  else
    stage_node_modules_connect "$resources/app"
  fi

  # Ad-hoc sign so Gatekeeper is slightly happier on friends' Macs
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$app" 2>/dev/null || true
  fi

  local zip_name
  if [[ "$kind" == "host" ]]; then
    zip_name="Bay-Host-${ARCH}.zip"
  else
    zip_name="Bay-Connect-${ARCH}.zip"
  fi
  echo "==> Zipping $zip_name"
  (
    cd "$STAGE"
    ditto -c -k --sequesterRsrc --keepParent "${name}.app" "$DIST/$zip_name"
  )
  echo "   -> $DIST/$zip_name"
}

build_app "Bay Host" host
build_app "Bay Connect" connect

# Convenience: also leave unzipped apps in dist for local smoke
rm -rf "$DIST/Bay Host.app" "$DIST/Bay Connect.app"
cp -R "$STAGE/Bay Host.app" "$DIST/"
cp -R "$STAGE/Bay Connect.app" "$DIST/"

cat >"$DIST/SHA256SUMS.txt" <<EOF
$(cd "$DIST" && shasum -a 256 Bay-Host-${ARCH}.zip Bay-Connect-${ARCH}.zip)
EOF

echo ""
echo "Done. Artifacts in $DIST"
ls -lh "$DIST"/*.zip
echo ""
echo "Friends install: unzip → drag to Applications → Right-click → Open (first time)."
echo "Publish: gh release create v${VERSION} dist/macos/Bay-Host-${ARCH}.zip dist/macos/Bay-Connect-${ARCH}.zip"
