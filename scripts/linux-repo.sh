#!/usr/bin/env bash
# Build the Genex package repository (packages.genex.games) for one release: an apt repository
# (dists/stable, pool/) and a dnf repository (rpm/), both signed, plus the public key at genex.asc.
# The index names only this release, so apt and dnf always resolve to the newest version.
#
#   scripts/linux-repo.sh <dir with genex_*_amd64.deb and genex-*.x86_64.rpm> <out dir> <public key>
#
# The signing key is the one in gpg's default keyring whose fingerprint is in LINUX_REPO_KEY_ID.
# Needs apt-utils, gpg, rpm (rpmsign) and createrepo-c (.github/workflows/linux-repo.yml).
set -euo pipefail

in=$1 out=$2 public_key=$3
key=${LINUX_REPO_KEY_ID:?the signing key fingerprint}
deb=$(find "$in" -maxdepth 1 -name 'genex_*_amd64.deb' | sort | tail -1)
rpm=$(find "$in" -maxdepth 1 -name 'genex-*.x86_64.rpm' | sort | tail -1)
[ -n "$deb" ] && [ -n "$rpm" ] || { echo "no genex .deb and .rpm in $in" >&2; exit 1; }
sign=(gpg --batch --yes --pinentry-mode loopback --local-user "$key")

# apt: pool/ holds the package, dists/stable its signed index.
pool=pool/main/g/genex
binary=dists/stable/main/binary-amd64
mkdir -p "$out/$pool" "$out/$binary" "$out/rpm"
cp "$deb" "$out/$pool/"
(cd "$out" && apt-ftparchive packages pool > "$binary/Packages" && gzip -9kf "$binary/Packages")
release=$(mktemp)
(cd "$out/dists/stable" && apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Genex -o APT::FTPArchive::Release::Label=Genex \
  -o APT::FTPArchive::Release::Suite=stable -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 -o APT::FTPArchive::Release::Components=main \
  release . > "$release")
mv "$release" "$out/dists/stable/Release"
"${sign[@]}" --clearsign -o "$out/dists/stable/InRelease" "$out/dists/stable/Release"
"${sign[@]}" --armor --detach-sign -o "$out/dists/stable/Release.gpg" "$out/dists/stable/Release"

# dnf: the package signed (gpgcheck) and the metadata signed (repo_gpgcheck).
cp "$rpm" "$out/rpm/"
rpmsign --addsign --define "_gpg_name $key" \
  --define "_gpg_sign_cmd_extra_args --batch --pinentry-mode loopback" "$out/rpm/$(basename "$rpm")"
createrepo_c --quiet "$out/rpm"
"${sign[@]}" --armor --detach-sign -o "$out/rpm/repodata/repomd.xml.asc" "$out/rpm/repodata/repomd.xml"

cp "$public_key" "$out/genex.asc"
find "$out" -type f | sort
