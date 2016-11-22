# CHANGELOG

## 4.5.0

Features:
  * Add ability to checkout with a username and access token by setting `SCM_USERNAME` and `SCM_ACCESS_TOKEN` as secrets inside `screwdriver.yaml`

## 4.4.0

Features:
  * Implement `_getCheckoutCommand` method defined in [scm-base](https://github.com/screwdriver-cd/scm-base).

## 4.3.0

Bug fixes:
  * Upgrade data-schema package version to v15.
  * Better error message when repo does not exist.
  * Gracefully handle missing user.

## 4.2.0

Bug fixes:
  * Upgrade node-github package version to v6.

## 4.1.0

Breaking changes:
  * `parseHook` returns null when webhook event type is not `pull_request` or `repo`; uses promises.
