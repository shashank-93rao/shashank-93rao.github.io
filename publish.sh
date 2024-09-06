#!/bin/sh

rm -rf ./docs
mkdir ./docs
cd shashank && hugo && cd ..
cp -r shashank/public/* docs/
