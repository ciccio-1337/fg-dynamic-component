#!/bin/bash

cd "$(dirname "$0")"
rimraf .angular
rimraf node_modules

# Keep package-lock.json so dependency upgrades remain reviewable and pinned.
ncu -u
npm install
