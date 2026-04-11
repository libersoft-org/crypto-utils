#!/bin/sh

cd src
bun prettier --plugin prettier-plugin-svelte --write "**/*.{js,ts,svelte,html,css,json}"
cd ..
