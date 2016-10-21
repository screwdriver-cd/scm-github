'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');

const testPayloadClose = require('./data/github.pull_request.closed.json');
const testPayloadOpen = require('./data/github.pull_request.opened.json');
const testPayloadPush = require('./data/github.push.json');
const testPayloadSync = require('./data/github.pull_request.synchronize.json');

sinon.assert.expose(assert, {
    prefix: ''
});

describe('index', () => {
    let GithubScm;
    let scm;
    let githubMock;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        githubMock = {
            authenticate: sinon.stub(),
            repos: {
                createStatus: sinon.stub(),
                get: sinon.stub(),
                getBranch: sinon.stub(),
                getById: sinon.stub(),
                getCommit: sinon.stub(),
                getContent: sinon.stub()
            },
            users: {
                getForUser: sinon.stub()
            }
        };

        mockery.registerMock('github', sinon.stub().returns(githubMock));

        /* eslint-disable global-require */
        GithubScm = require('../index');
        /* eslint-enable global-require */

        scm = new GithubScm({
            retry: {
                minTimeout: 10
            }
        });
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    it('extends base class', () => {
        assert.isFunction(scm.getPermissions);
        assert.isFunction(scm.getCommitSha);
        assert.isFunction(scm.updateCommitStatus);
    });

    describe('getCommitSha', () => {
        const scmUri = 'github.com:920414:master';
        const branch = {
            commit: {
                sha: '1234567'
            }
        };
        const config = {
            scmUri,
            token: 'somerandomtoken'
        };

        it('promises to get the commit sha', () => {
            githubMock.repos.getBranch.yieldsAsync(null, branch);
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });

            return scm.getCommitSha(config)
                .then((data) => {
                    assert.deepEqual(data, branch.commit.sha);

                    assert.calledWith(githubMock.repos.getBranch, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        host: 'github.com',
                        branch: 'master'
                    });
                    assert.calledWith(githubMock.repos.getById, {
                        id: '920414'
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('fails when unable to get a repo by ID', () => {
            const error = new Error('githubBreaking');

            githubMock.repos.getById.yieldsAsync(error);

            return scm.getCommitSha(config)
                .then(() => {
                    assert.fail('This should not fail the test');
                })
                .catch((err) => {
                    assert.deepEqual(err, error);

                    assert.calledWith(githubMock.repos.getById, {
                        id: '920414'
                    });

                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('fails when unable to get the branch info from a repo', () => {
            const error = new Error('githubBreaking');

            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });
            githubMock.repos.getBranch.yieldsAsync(error);

            return scm.getCommitSha(config).then(() => {
                assert.fail('This should not fail the test');
            }).catch((err) => {
                assert.deepEqual(err, error);

                assert.calledWith(githubMock.repos.getBranch, {
                    user: 'screwdriver-cd',
                    repo: 'models',
                    host: 'github.com',
                    branch: 'master'
                });

                assert.calledWith(githubMock.repos.getById, {
                    id: '920414'
                });

                assert.calledWith(githubMock.authenticate, {
                    type: 'oauth',
                    token: config.token
                });
            });
        });
    });

    describe('getPermissions', () => {
        const scmUri = 'github.com:359478:master';
        const repo = {
            permissions: {
                admin: true,
                push: false,
                pull: false
            }
        };
        const config = {
            scmUri,
            token: 'somerandomtoken'
        };

        beforeEach(() => {
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });
        });

        it('promises to get permissions', () => {
            githubMock.repos.get.yieldsAsync(null, repo);

            return scm.getPermissions(config)
                .then((data) => {
                    assert.deepEqual(data, repo.permissions);

                    assert.calledWith(githubMock.repos.getById, {
                        id: '359478'
                    });

                    assert.calledWith(githubMock.repos.get, {
                        user: 'screwdriver-cd',
                        repo: 'models'
                    });

                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('returns an error when github command fails', () => {
            const err = new Error('githubError');

            githubMock.repos.get.yieldsAsync(err);

            return scm.getPermissions(config)
                .then(() => {
                    assert.fail('This should not fail the test');
                })
                .catch((error) => {
                    assert.deepEqual(error, err);

                    assert.calledWith(githubMock.repos.getById, {
                        id: '359478'
                    });

                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });
    });

    describe('lookupScmUri', () => {
        const scmUri = 'github.com:23498:targetBranch';

        it('looks up a repo by SCM URI', () => {
            const testResponse = {
                full_name: 'screwdriver-cd/models'
            };

            githubMock.repos.getById.yieldsAsync(null, testResponse);

            return scm.lookupScmUri({
                scmUri,
                token: 'sometoken'
            }).then((repoData) => {
                assert.deepEqual(repoData, {
                    branch: 'targetBranch',
                    host: 'github.com',
                    repo: 'models',
                    user: 'screwdriver-cd'
                });

                assert.calledWith(githubMock.repos.getById, {
                    id: '23498'
                });
                assert.calledWith(githubMock.authenticate, {
                    type: 'oauth',
                    token: 'sometoken'
                });
            });
        });

        it('rejects when github command fails', () => {
            const testError = new Error('githubError');

            githubMock.repos.getById.yieldsAsync(testError);

            return scm.lookupScmUri({
                scmUri,
                token: 'sometoken'
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (error) => {
                assert.deepEqual(error, testError);

                assert.calledWith(githubMock.repos.getById, {
                    id: '23498'
                });
                assert.calledWith(githubMock.authenticate, {
                    type: 'oauth',
                    token: 'sometoken'
                });
            });
        });
    });

    describe('updateCommitStatus', () => {
        const scmUri = 'github.com:14052:master';
        const data = {
            permissions: {
                admin: true,
                push: false,
                pull: false
            }
        };
        let config;

        beforeEach(() => {
            config = {
                scmUri,
                sha: 'ccc49349d3cffbd12ea9e3d41521480b4aa5de5f',
                buildStatus: 'SUCCESS',
                token: 'somerandomtoken'
            };

            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });
            githubMock.repos.createStatus.yieldsAsync(null, data);
        });

        it('promises to update commit status on success', () =>
            scm.updateCommitStatus(config)
            .then((result) => {
                assert.deepEqual(result, data);

                assert.calledWith(githubMock.repos.getById, {
                    id: '14052'
                });
                assert.calledWith(githubMock.repos.createStatus, {
                    user: 'screwdriver-cd',
                    repo: 'models',
                    sha: config.sha,
                    state: 'success',
                    description: 'Everything looks good!',
                    context: 'Screwdriver'
                });
                assert.calledWith(githubMock.authenticate, {
                    type: 'oauth',
                    token: config.token
                });
            })
        );

        it('sets a target_url when id passed in', () => {
            config.url = 'http://localhost/v3/builds/1234/logs';

            return scm.updateCommitStatus(config)
                .then((result) => {
                    assert.deepEqual(result, data);

                    assert.calledWith(githubMock.repos.getById, {
                        id: '14052'
                    });
                    assert.calledWith(githubMock.repos.createStatus, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'success',
                        description: 'Everything looks good!',
                        context: 'Screwdriver',
                        target_url: 'http://localhost/v3/builds/1234/logs'
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('sets a better context when jobName passed in', () => {
            config.jobName = 'PR-15';

            return scm.updateCommitStatus(config)
                .then((result) => {
                    assert.deepEqual(result, data);

                    assert.calledWith(githubMock.repos.createStatus, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'success',
                        description: 'Everything looks good!',
                        context: 'Screwdriver/PR-15'
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('promises to update commit status on failure', () => {
            config.buildStatus = 'FAILURE';

            return scm.updateCommitStatus(config)
                .then((result) => {
                    assert.deepEqual(result, data);

                    assert.calledWith(githubMock.repos.createStatus, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'failure',
                        description: 'Did not work as expected.',
                        context: 'Screwdriver'
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('returns an error when github command fails', () => {
            const err = new Error('githubError');

            githubMock.repos.createStatus.yieldsAsync(err);

            return scm.updateCommitStatus(config)
                .then(() => {
                    assert.fail('This should not fail the test');
                })
                .catch((error) => {
                    assert.deepEqual(error, err);

                    assert.calledWith(githubMock.repos.createStatus, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'success',
                        description: 'Everything looks good!',
                        context: 'Screwdriver'
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                    assert.strictEqual(scm.breaker.getTotalRequests(), 6);
                });
        });
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            const config = {
                scmUri: 'github.com:28476:master',
                sha: 'ccc49349d3cffbd12ea9e3d41521480b4aa5de5f',
                buildStatus: 'SUCCESS',
                token: 'somerandomtoken'
            };

            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });
            githubMock.repos.createStatus.yieldsAsync(null, {});

            return scm.updateCommitStatus(config)
                .then(() => {
                    // Because averageTime isn't deterministic on how long it will take,
                    // will need to check each value separately.
                    const stats = scm.stats();

                    assert.strictEqual(stats.requests.total, 2);
                    assert.strictEqual(stats.requests.timeouts, 0);
                    assert.strictEqual(stats.requests.success, 2);
                    assert.strictEqual(stats.requests.failure, 0);
                    assert.strictEqual(stats.breaker.isClosed, true);
                });
        });
    });

    describe('getFile', () => {
        const scmUri = 'github.com:146:master';
        const content = `IyB3b3JrZmxvdzoKIyAgICAgLSBwdWJsaXNoCgpqb2JzOgogICAgbWFpbjoK\n
ICAgICAgICBpbWFnZTogbm9kZTo2CiAgICAgICAgc3RlcHM6CiAgICAgICAg\n
ICAgIC0gaW5zdGFsbDogbnBtIGluc3RhbGwKICAgICAgICAgICAgLSB0ZXN0\n
OiBucG0gdGVzdAoKICAgICMgcHVibGlzaDoKICAgICMgICAgIHN0ZXBzOgog\n
ICAgIyAgICAgICAgIGNvbmZpZ3VyZTogLi9zY3JpcHRzL2NvbmZpZ3VyZQog\n
ICAgIyAgICAgICAgIGluc3RhbGw6IG5wbSBpbnN0YWxsCiAgICAjICAgICAg\n
ICAgYnVtcDogbnBtIHJ1biBidW1wCiAgICAjICAgICAgICAgcHVibGlzaDog\n
bnBtIHB1Ymxpc2ggJiYgZ2l0IHB1c2ggb3JpZ2luIC0tdGFncyAtcQo=\n'`;
        const returnData = {
            type: 'file',
            content,
            encoding: 'base64'
        };
        const returnInvalidData = {
            type: 'notFile'
        };
        const expectedYaml = `# workflow:
#     - publish

jobs:
    main:
        image: node:6
        steps:
            - install: npm install
            - test: npm test

    # publish:
    #     steps:
    #         configure: ./scripts/configure
    #         install: npm install
    #         bump: npm run bump
    #         publish: npm publish && git push origin --tags -q
`;
        const config = {
            scmUri,
            path: 'screwdriver.yaml',
            token: 'somerandomtoken',
            ref: '46f1a0bd5592a2f9244ca321b129902a06b53e03'
        };

        const configNoRef = {
            scmUri,
            path: 'screwdriver.yaml',
            token: 'somerandomtoken'
        };

        beforeEach(() => {
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });
        });

        it('promises to get content when a ref is passed', () => {
            githubMock.repos.getContent.yieldsAsync(null, returnData);

            return scm.getFile(config)
                .then((data) => {
                    assert.deepEqual(data, expectedYaml);

                    assert.calledWith(githubMock.repos.getContent, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        path: config.path,
                        ref: config.ref
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('promises to get content when a ref is not passed', () => {
            githubMock.repos.getContent.yieldsAsync(null, returnData);

            return scm.getFile(configNoRef)
                .then((data) => {
                    assert.deepEqual(data, expectedYaml);

                    assert.calledWith(githubMock.repos.getContent, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        path: configNoRef.path,
                        ref: 'master'
                    });

                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('returns error when path is not a file', () => {
            const expectedErrorMessage = 'Path (screwdriver.yaml) does not point to file';

            githubMock.repos.getContent.yieldsAsync(null, returnInvalidData);

            return scm.getFile(config)
                .then(() => {
                    assert.fail('This should not fail the test');
                }, (err) => {
                    assert.strictEqual(err.message, expectedErrorMessage);

                    assert.calledWith(githubMock.repos.getContent, {
                        user: 'screwdriver-cd',
                        repo: 'models',
                        path: config.path,
                        ref: config.ref
                    });

                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('returns an error when github command fails', () => {
            const err = new Error('githubError');

            err.code = 404;

            githubMock.repos.getContent.yieldsAsync(err);

            return scm.getFile(config)
            .then(() => {
                assert.fail('This should not fail the test');
            })
            .catch((error) => {
                assert.calledWith(githubMock.repos.getContent, {
                    user: 'screwdriver-cd',
                    repo: 'models',
                    path: config.path,
                    ref: config.ref
                });

                assert.calledWith(githubMock.authenticate, {
                    type: 'oauth',
                    token: config.token
                });

                assert.deepEqual(error, err);
                assert.strictEqual(scm.breaker.getTotalRequests(), 2);
            });
        });
    });

    describe('parseHook', () => {
        const commonPullRequestParse = {
            branch: 'master',
            checkoutUrl: 'git@github.com:baxterthehacker/public-repo.git',
            prNum: 1,
            prRef: 'git@github.com:baxterthehacker/public-repo.git#pull/1/merge',
            sha: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
            type: 'pr',
            username: 'baxterthehacker'
        };
        let payloadChecker;
        let testHeaders;

        beforeEach(() => {
            testHeaders = {
                'x-github-event': null
            };

            payloadChecker = sinon.stub();
        });

        it('parses a payload for a push event payload', () => {
            testHeaders['x-github-event'] = 'push';

            return scm.parseHook(testHeaders, testPayloadPush)
                .then((result) => {
                    assert.deepEqual(result, {
                        action: 'push',
                        branch: 'master',
                        checkoutUrl: 'git@github.com:baxterthehacker/public-repo.git',
                        sha: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
                        type: 'repo',
                        username: 'baxterthehacker'
                    });
                });
        });

        it('parses a payload for a pull request event payload', () => {
            testHeaders['x-github-event'] = 'pull_request';

            return scm.parseHook(testHeaders, testPayloadOpen)
                .then((result) => {
                    payloadChecker(result);

                    assert.calledWith(payloadChecker, sinon.match(commonPullRequestParse));
                    assert.calledWith(payloadChecker, sinon.match({
                        action: 'opened'
                    }));
                });
        });

        it('parses a payload for a pull request being closed', () => {
            testHeaders['x-github-event'] = 'pull_request';

            return scm.parseHook(testHeaders, testPayloadClose)
                .then((result) => {
                    payloadChecker(result);
                    assert.calledWith(payloadChecker, sinon.match(commonPullRequestParse));
                    assert.calledWith(payloadChecker, sinon.match({
                        action: 'closed'
                    }));
                });
        });

        it('parses a payload for a pull request being synchronized', () => {
            testHeaders['x-github-event'] = 'pull_request';

            return scm.parseHook(testHeaders, testPayloadSync)
                .then((result) => {
                    payloadChecker(result);
                    assert.calledWith(payloadChecker, sinon.match(commonPullRequestParse));
                    assert.calledWith(payloadChecker, sinon.match({
                        action: 'synchronized'
                    }));
                });
        });

        it('throws an error when parsing an unsupported payload', () => {
            testHeaders['x-github-event'] = 'other_event';

            return scm.parseHook(testHeaders, testPayloadPush)
                .then(() => {
                    assert.fail('This should not fail the tests');
                }, (err) => {
                    assert.match(err.message, /Event other_event not supported/);
                });
        });
    });

    describe('parseUrl', () => {
        let checkoutUrl;
        const repoData = {
            id: 8675309,
            full_name: 'iAm/theCaptain'
        };
        const token = 'mygithubapitoken';
        const repoInfo = {
            host: 'github.com',
            repo: 'theCaptain',
            user: 'iAm'
        };

        beforeEach(() => {
            checkoutUrl = 'git@github.com:iAm/theCaptain.git#boat';
        });

        it('parses a complete ssh url', () => {
            githubMock.repos.get.yieldsAsync(null, repoData);

            return scm.parseUrl({
                checkoutUrl,
                token
            }).then((result) => {
                assert.strictEqual(result, 'github.com:8675309:boat');

                assert.calledWith(githubMock.repos.get, sinon.match(repoInfo));
                assert.calledWith(githubMock.repos.get, sinon.match({
                    branch: 'boat'
                }));
            });
        });

        it('parses a ssh url, defaulting the branch to master', () => {
            checkoutUrl = 'git@github.com:iAm/theCaptain.git';

            githubMock.repos.get.yieldsAsync(null, repoData);

            return scm.parseUrl({
                checkoutUrl,
                token
            }).then((result) => {
                assert.strictEqual(result, 'github.com:8675309:master');

                assert.calledWith(githubMock.repos.get, sinon.match(repoInfo));
                assert.calledWith(githubMock.repos.get, sinon.match({
                    branch: 'master'
                }));
            });
        });

        it('rejects when unable to match', () => {
            const invalidCheckoutUrl = 'invalidCheckoutUrl';

            // eslint-disable-next-line no-underscore-dangle
            return scm._parseUrl({
                checkoutUrl: invalidCheckoutUrl,
                token
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (err) => {
                assert.match(err.message, /Invalid scmUrl/);
            });
        });

        it('rejects when failing to communicate with github', () => {
            const expectedError = new Error('errorCommunicatingWithGithub');

            githubMock.repos.get.yieldsAsync(expectedError);

            return scm.parseUrl({
                checkoutUrl,
                token
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (err) => {
                assert.deepEqual(err, expectedError);

                assert.calledWith(githubMock.repos.get, sinon.match(repoInfo));
                assert.calledWith(githubMock.repos.get, sinon.match({
                    branch: 'boat'
                }));
            });
        });
    });

    describe('decorateAuthor', () => {
        const username = 'notmrkent';

        it('decorates a github user', () => {
            githubMock.users.getForUser.yieldsAsync(null, {
                login: username,
                id: 2042,
                avatar_url: 'https://avatars.githubusercontent.com/u/2042?v=3',
                html_url: `https://github.com/${username}`,
                name: 'Klark Cent'
            });

            return scm.decorateAuthor({
                token: 'tokenfordecorateauthor',
                username
            }).then((data) => {
                assert.deepEqual(data, {
                    avatar: 'https://avatars.githubusercontent.com/u/2042?v=3',
                    name: 'Klark Cent',
                    url: `https://github.com/${username}`,
                    username
                });

                assert.calledWith(githubMock.users.getForUser, {
                    user: username
                });
            });
        });

        it('defaults to username when display name does not exist', () => {
            githubMock.users.getForUser.yieldsAsync(null, {
                login: username,
                id: 2042,
                avatar_url: 'https://avatars.githubusercontent.com/u/2042?v=3',
                html_url: `https://github.com/${username}`,
                name: null
            });

            return scm.decorateAuthor({
                token: 'tokenfordecorateauthor',
                username
            }).then((data) => {
                assert.deepEqual(data, {
                    avatar: 'https://avatars.githubusercontent.com/u/2042?v=3',
                    name: username,
                    url: `https://github.com/${username}`,
                    username
                });

                assert.calledWith(githubMock.users.getForUser, {
                    user: username
                });
            });
        });

        it('rejects when failing to communicate with github', () => {
            const testError = new Error('someGithubCommError');

            githubMock.users.getForUser.yieldsAsync(testError);

            return scm.decorateAuthor({
                token: 'randomtoken',
                username
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (err) => {
                assert.deepEqual(err, testError);

                assert.calledWith(githubMock.users.getForUser, {
                    user: username
                });
            });
        });
    });

    describe('decorateCommit', () => {
        const repoName = 'peel';
        const repoOwner = 'banana';
        const scmId = '089253';
        const scmUri = `internal-ghe.mycompany.com:${scmId}:yummy`;
        const sha = '26516f13718705497086a00929eedf45eb729fe6';
        const username = 'notbrucewayne';

        beforeEach(() => {
            githubMock.users.getForUser.yieldsAsync(null, {
                login: username,
                id: 1234567,
                avatar_url: 'https://avatars.githubusercontent.com/u/1234567?v=3',
                html_url: `https://internal-ghe.mycompany.com/${username}`,
                name: 'Batman Wayne'
            });

            githubMock.repos.getById.yieldsAsync(null, {
                full_name: `${repoOwner}/${repoName}`
            });
        });

        it('decorates a commit', () => {
            githubMock.repos.getCommit.yieldsAsync(null, {
                commit: {
                    message: 'some commit message that is here'
                },
                author: {
                    login: username
                },
                html_url: 'https://link.to/commitDiff'
            });

            return scm.decorateCommit({
                scmUri,
                sha,
                token: 'tokenfordecoratecommit'
            }).then((data) => {
                assert.deepEqual(data, {
                    author: {
                        avatar: 'https://avatars.githubusercontent.com/u/1234567?v=3',
                        name: 'Batman Wayne',
                        url: 'https://internal-ghe.mycompany.com/notbrucewayne',
                        username: 'notbrucewayne'
                    },
                    message: 'some commit message that is here',
                    url: 'https://link.to/commitDiff'
                });

                assert.calledWith(githubMock.repos.getById, {
                    id: scmId
                });
                assert.calledWith(githubMock.repos.getCommit, {
                    user: repoOwner,
                    repo: repoName,
                    sha
                });
                assert.calledWith(githubMock.users.getForUser, {
                    user: username
                });
            });
        });

        it('rejects when failing to communicate with github', () => {
            const testError = new Error('theErrIexpect');

            githubMock.repos.getCommit.yieldsAsync(testError);

            return scm.decorateCommit({
                scmUri,
                sha,
                token: 'tokenforfailingtodecorate'
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (err) => {
                assert.deepEqual(err, testError);

                assert.calledWith(githubMock.repos.getCommit, {
                    user: 'banana',
                    repo: 'peel',
                    sha
                });
            });
        });
    });

    describe('decorateUrl', () => {
        it('decorates a scm uri', () => {
            const scmUri = 'github.com:102498:boat';

            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'iAm/theCaptain'
            });

            return scm.decorateUrl({
                scmUri,
                token: 'mytokenfortesting'
            }).then((data) => {
                assert.deepEqual(data, {
                    branch: 'boat',
                    name: 'iAm/theCaptain',
                    url: 'https://github.com/iAm/theCaptain/tree/boat'
                });

                assert.calledWith(githubMock.repos.getById, {
                    id: '102498'
                });
            });
        });

        it('rejects when github lookup fails', () => {
            const scmUri = 'github.com:102498:boat';
            const testError = new Error('decorateUrlError');

            githubMock.repos.getById.yieldsAsync(testError);

            return scm.decorateUrl({
                scmUri,
                token: 'mytokenfortesting'
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (err) => {
                assert.deepEqual(err, testError);

                assert.calledWith(githubMock.repos.getById, {
                    id: '102498'
                });
            });
        });
    });
});
