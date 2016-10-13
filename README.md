# scm-github
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

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

### parseUrl
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config             | Object | Configuration Object |
| config.checkoutUrl | String | Checkout url for a repo to parse |
| config.token  | String | The scm token to check permissions on |

#### Expected Outcome
An scmUri (ex: `github.com:1234:branchName`, where 1234 is a repo ID number), which will be a unique identifier for the repo and branch in Screwdriver.

#### Expected Promise response
1. Resolve with an scm uri for the repository
2. Reject if not able to parse url

### parseHook
Required parameters:

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| headers        | Object | The request headers associated with the webhook payload |
| payload        | Object | The webhook payload received from the SCM service |

#### Expected Outcome
A key-map of data related to the received payload in the form of:
```js
{
    type: 'pr',         // can be 'pr' or 'repo'
    action: 'opened',   // can be 'opened', 'closed', or 'synchronized' for type 'pr'; 'push' for type 'repo'
    username: 'batman',
    checkoutUrl: 'https://batman@bitbucket.org/batman/test.git',
    branch: 'mynewbranch',
    sha: '40171b678527',
    prNum: 3,
    prRef: 'refs/pull-requests/3/from'
}
```

#### Expected Promise response
1. Resolve with a parsed hook object
2. Reject if not able to parse hook

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

### stats
Returns circuit breaker statistics for interactions with github

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
[status-image]: https://cd.screwdriver.cd/pipelines/dcfd8d2b0d5ba460675a7d20b910ca298a846d17/badge
[status-url]: https://cd.screwdriver.cd/pipelines/dcfd8d2b0d5ba460675a7d20b910ca298a846d17
[daviddm-image]: https://david-dm.org/screwdriver-cd/scm-github.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/scm-github
[scm-base-class]: https://github.com/screwdriver-cd/scm-base
