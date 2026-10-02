#!/usr/bin/env bash
# Ajoute ?v=<version> aux fichiers de l'app pour que les navigateurs (Safari en particulier)
# rechargent tout ensemble après chaque publication, au lieu de mélanger ancien et nouveau code.
set -euo pipefail
dir="$1"
version="$2"
# Imports entre modules : from './x.js' → from './x.js?v=…'
sed -i -E "s#(from '\./[a-z-]+\.js)'#\1?v=${version}'#g" "$dir"/js/*.js
# Feuilles de style et scripts référencés par les pages
sed -i -E "s#(href|src)=\"((styles\.css)|(js/app\.js)|(vendor/[^\"]+\.(js|css)))\"#\1=\"\2?v=${version}\"#g" "$dir"/index.html "$dir"/aide.html
