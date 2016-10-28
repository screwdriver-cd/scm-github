# CHANGELOG

## 4.2.0

Bug fixes:
  * Upgrade node-github package version to v6.

## 4.1.0

Breaking changes:
  * `parseHook` returns null when webhook event type is not `pull_request` or `repo`; uses promises
