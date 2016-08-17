# scm-github
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][wercker-image]][wercker-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> Github implementation for the scm-base class

This scm plugin extends the [scm-base-class], and provides methods to fetch and update data in github.

## Usage

```bash
npm install screwdriver-scm-github
```

### Configure
TODO: allow github values to be configurable

### formatScmUrl
The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| scmUrl        | String | Scm Url to format |

The intention of the `formatScmUrl` function is to return a formatted scm url to be used as a unique key.

### getPermissions
The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.scmUrl | String | The scmUrl to get permissions on |
| config.token | String | The github token to check permissions on |

The `getPermissions` function will fetch permissions from github for a given user on a specified repository

The `getPermissions` function returns a promise that resolves to an object of permissions fetched from github.

### getCommitSha
The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.scmUrl | String | The scmUrl to get permissions on |
| config.token | String | The github token to check permissions on |

The `getCommitSha` function will fetch the commit sha for a given branch on a repository.

The `getCommitSha` function returns a promise that will resolve to a git commit sha value.

### updateCommitStatus
The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.scmUrl | String | The scmUrl to get permissions on |
| config.token | String | The github token to check permissions on |
| config.sha | String | The github sha to update a status for |
| config.buildStatus | String | The screwdriver build status to translate into github commit status |

The `updateCommitStatus` function will update the commit status for a given repository and sha.

The `updateCommitStatus` function returns a promise that will resolve to the data returned back from github.

### getFile
The parameters required are:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.scmUrl | String | The scmUrl to get permissions on |
| config.token | String | The github token to check permissions on |
| config.path | String | The path to the file on github to read |
| config.ref | String | The reference to the github repo, could be a branch or sha |

The `getFile` function returns a promise that will resolve to the contents of a file that is returned back from github.

The function will reject if the path does not point to a file.

## Testing

```bash
npm test
```

## License

Code licensed under the BSD 3-Clause license. See LICENSE file for terms.

[npm-image]: https://img.shields.io/npm/v/screwdriver-scm-github.svg
[npm-url]: https://npmjs.org/package/screwdriver-scm-github
[downloads-image]: https://img.shields.io/npm/dt/screwdriver-scm-github.svg
[license-image]: https://img.shields.io/npm/l/screwdriver-scm-github.svg
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/scm-github.svg
[issues-url]: https://github.com/screwdriver-cd/scm-github/issues
[wercker-image]: https://app.wercker.com/status/66233627336e0a0cac7999332a0a6d34
[wercker-url]: https://app.wercker.com/project/bykey/66233627336e0a0cac7999332a0a6d34
[daviddm-image]: https://david-dm.org/screwdriver-cd/scm-github.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/scm-github
[scm-base-class]: https://github.com/screwdriver-cd/scm-base
