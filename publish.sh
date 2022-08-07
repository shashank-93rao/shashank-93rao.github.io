#!/bin/sh

rm -rf ./docs
mkdir ./docs
cd hugo && hugo -D && cd ..
cp -r hugo/public/* docs/
