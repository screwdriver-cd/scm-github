# scm-github
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> This scm plugin extends the [scm-base-class], and provides methods to fetch and update data in github.

## Usage

```bash
npm install screwdriver-scm-github
```

### Initialization

The class has a variety of knobs to tweak when interacting with GitHub.

| Parameter        | Type  |  Description |
| :-------------   | :---- | :-------------|
| config        | Object | Configuration Object |
| config.gheHost (null) | String | If using GitHub Enterprise, the host/port of the deployed instance |
| config.gheProtocol (https) | String | If using GitHub Enterprise, the protocol to use |
| config.username (sd-buildbot) | String | GitHub username for checkout |
| config.email (dev-null@screwdriver.cd) | String | GitHub user email for checkout |
| config.https (false) | Boolean | Is the Screwdriver API running over HTTPS |
| config.oauthClientId | String | OAuth Client ID provided by GitHub application |
| config.oauthClientSecret | String | OAuth Client Secret provided by GitHub application |
| config.fusebox ({}) | Object | [Circuit Breaker configuration][circuitbreaker] |
| config.secret | String | Secret to validate the signature of webhook events |

```js
const scm = new GithubScm({
    oauthClientId: 'abcdef',
    oauthClientSecret: 'hijklm',
    secret: 'somesecret'
});
```

### Methods

For more information on the exposed methods please see the [scm-base-class].

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
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/screwdriver.svg
[issues-url]: https://github.com/screwdriver-cd/screwdriver/issues
[status-image]: https://cd.screwdriver.cd/pipelines/8/badge
[status-url]: https://cd.screwdriver.cd/pipelines/8
[daviddm-image]: https://david-dm.org/screwdriver-cd/scm-github.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/scm-github
[scm-base-class]: https://github.com/screwdriver-cd/scm-base
