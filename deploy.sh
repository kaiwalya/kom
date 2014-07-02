#!/bin/bash

mkdir -p _deploy

commitCount=`git rev-list --count HEAD`

branch=`git rev-parse --abbrev-ref HEAD`

commitId=`git rev-parse --short HEAD`

now=`date -j +%s`
echo $now

archiveName="$now.$commitId.$branch.$commitCount"
echo $archiveName

git ls-tree -r HEAD --name-only | zip -r _deploy/"$archiveName".zip -@

