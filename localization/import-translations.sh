#!/bin/sh

### Copyright (c) 2019, The Tor Project, Inc.
### See LICENSE for licensing information.

TRANSLATION_BRANCHES="
tor-launcher-network-settings
tor-launcher-properties
"

# Import translated string files from the translation git repository.
echo "Updating translated files"
if [ -d translation ]; then
  cd translation
  git fetch origin
  cd ..
else
  git clone https://git.torproject.org/translation.git
fi

cd translation
for branch in ${TRANSLATION_BRANCHES}
do
  git checkout --quiet ${branch}
  git merge --quiet origin/${branch}
  for locale in *
  do
    target_locale=$(echo "${locale}" | tr _ -)
    if [ "${target_locale}" = "en" -o "${target_locale}" = "en-US" \
        -o ! -d "${locale}" ]; then
      continue
    fi
    target="../../src/chrome/locale/${target_locale}"
    mkdir -p "${target}"
    cp -f "${locale}"/* "${target}"/
  done
done
cd ..

# Remove all locales that are missing one or more string files.
# Remove all locales for which no translation has been done.
# Re-create the chrome.manifest and jar.mn files by appending to templates.
echo "Removing incomplete locales; updating chrome.manifest and jar.mn"
cd ../src/chrome/locale
CHROME_MANIFEST=../../../chrome.manifest
JAR_MN=../../../jar.mn
cp ${CHROME_MANIFEST}.in ${CHROME_MANIFEST}
cp ${JAR_MN}.in ${JAR_MN}
REQUIRED_TRANSLATION_FILES=`ls -1 en-US/`
for locale in *; do
  if [ "${locale}" = "en-US" ]; then
    continue
  fi
  omit_locale=0
  for f in ${REQUIRED_TRANSLATION_FILES}; do
    if [ ! -e "${locale}/${f}" ]; then
      echo "Removing locale ${locale} due to missing resource ${f}"
      omit_locale=1
      break
    fi
  done
  if [ ${omit_locale} -eq 0 ]; then
    diff -r en-US "${locale}" > /dev/null
    if [ $? -eq 0 ]; then
      echo "Removing locale ${locale} because it has the same content as en-US"
      omit_locale=1
    fi
  fi
  if [ ${omit_locale} -ne 0 ]; then
    rm -rf "${locale}"
  else
    echo "locale torlauncher ${locale} chrome/locale/${locale}/" >> \
        ${CHROME_MANIFEST}
    echo "% locale torlauncher ${locale} %locale/${locale}/" >> \
        ${JAR_MN}
    echo "  locale/${locale}/ (src/chrome/locale/${locale}/*)" >> \
        ${JAR_MN}
  fi
done
