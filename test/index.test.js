'use strict';

const assert = require('chai').assert;
const mockery = require('mockery');
const sinon = require('sinon');

const testPayloadClose = require('./data/github.pull_request.closed.json');
const testPayloadOpen = require('./data/github.pull_request.opened.json');
const testPayloadPush = require('./data/github.push.json');
const testPayloadSync = require('./data/github.pull_request.synchronize.json');
const testPayloadBadAction = require('./data/github.pull_request.badAction.json');
const testPayloadPing = require('./data/github.ping.json');
const testCommands = require('./data/commands.json');
const testPrCommands = require('./data/prCommands.json');
const testCustomPrCommands = require('./data/customPrCommands.json');

sinon.assert.expose(assert, {
    prefix: ''
});

describe('index', function () {
    // Time not important. Only life important
    this.timeout(5000);

    let GithubScm;
    let scm;
    let githubMock;
    let githubMockClass;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        githubMock = {
            authenticate: sinon.stub(),
            pullRequests: {
                getAll: sinon.stub(),
                get: sinon.stub()
            },
            repos: {
                createHook: sinon.stub(),
                createStatus: sinon.stub(),
                editHook: sinon.stub(),
                get: sinon.stub(),
                getBranch: sinon.stub(),
                getById: sinon.stub(),
                getCommit: sinon.stub(),
                getContent: sinon.stub(),
                getHooks: sinon.stub()
            },
            users: {
                getForUser: sinon.stub()
            }
        };
        githubMockClass = sinon.stub().returns(githubMock);

        mockery.registerMock('github', githubMockClass);

        /* eslint-disable global-require */
        GithubScm = require('../index');
        /* eslint-enable global-require */

        scm = new GithubScm({
            fusebox: {
                retry: {
                    minTimeout: 1
                }
            },
            oauthClientId: 'abcdefg',
            oauthClientSecret: 'hijklmno',
            secret: 'somesecret'
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

    describe('constructor', () => {
        it('validates input', () => {
            try {
                scm = new GithubScm();
                assert.fail('should not get here');
            } catch (err) {
                assert.instanceOf(err, Error);
                assert.equal(err.name, 'ValidationError');
            }
        });

        it('can configure for GitHub.com', () => {
            scm = new GithubScm({
                oauthClientId: 'abcdefg',
                oauthClientSecret: 'hijklmno',
                secret: 'somesecret'
            });
            assert.calledWith(githubMockClass, {});
        });

        it('can configure for GHE', () => {
            scm = new GithubScm({
                gheHost: 'github.screwdriver.cd',
                oauthClientId: 'abcdefg',
                oauthClientSecret: 'hijklmno',
                secret: 'somesecret'
            });
            assert.calledWith(githubMockClass, {
                host: 'github.screwdriver.cd',
                protocol: 'https',
                pathPrefix: '/api/v3'
            });
        });
    });

    describe('getCheckoutCommand', () => {
        const config = {
            branch: 'branchName',
            host: 'github.com',
            org: 'screwdriver-cd',
            repo: 'guide',
            sha: '12345'
        };

        it('promises to get the checkout command for the pipeline branch', () =>
            scm.getCheckoutCommand(config)
                .then((command) => {
                    assert.deepEqual(command, testCommands);
                })
        );

        it('promises to get the checkout command for a pull request', () => {
            config.prRef = 'pull/3/merge';

            return scm.getCheckoutCommand(config)
                .then((command) => {
                    assert.deepEqual(command, testPrCommands);
                });
        });

        it('promises to get the checkout command with custom username and email', () => {
            scm = new GithubScm({
                oauthClientId: 'abcdefg',
                oauthClientSecret: 'hijklmno',
                secret: 'somesecret',
                username: 'pqrs',
                email: 'dev-null@my.email.com'
            });

            return scm.getCheckoutCommand(config)
                .then((command) => {
                    assert.deepEqual(command, testCustomPrCommands);
                });
        });
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

        it('promises to get the commit sha without prNum', () => {
            githubMock.repos.getBranch.yieldsAsync(null, branch);
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });

            return scm.getCommitSha(config)
                .then((data) => {
                    assert.deepEqual(data, branch.commit.sha);

                    assert.calledWith(githubMock.repos.getBranch, {
                        owner: 'screwdriver-cd',
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

        it('promises to get the commit sha with prNum', () => {
            config.prNum = 1;
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'screwdriver-cd/models'
            });
            githubMock.pullRequests.get.yieldsAsync(null,
                { number: config.prNum, head: { sha: branch.commit.sha } }
            );

            return scm.getCommitSha(config)
                .then((data) => {
                    assert.deepEqual(data, branch.commit.sha);

                    assert.calledWith(githubMock.pullRequests.get, {
                        owner: 'screwdriver-cd',
                        repo: 'models',
                        number: config.prNum
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                    delete config.prNum;
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
                    owner: 'screwdriver-cd',
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
                        owner: 'screwdriver-cd',
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
                    owner: 'screwdriver-cd'
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
                token: 'somerandomtoken',
                url: 'https://foo.bar',
                jobName: 'main',
                pipelineId: 675
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
                        owner: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'success',
                        description: 'Everything looks good!',
                        context: 'Screwdriver/675/main',
                        target_url: 'https://foo.bar'
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                })
        );

        it('sets context for PR when jobName passed in', () => {
            config.jobName = 'PR-15:test';

            return scm.updateCommitStatus(config)
                .then((result) => {
                    assert.deepEqual(result, data);

                    assert.calledWith(githubMock.repos.createStatus, {
                        owner: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'success',
                        description: 'Everything looks good!',
                        context: 'Screwdriver/675/PR:test',
                        target_url: 'https://foo.bar'
                    });
                    assert.calledWith(githubMock.authenticate, {
                        type: 'oauth',
                        token: config.token
                    });
                });
        });

        it('sets context for regular job when jobName passed in', () => {
            config.jobName = 'main';

            return scm.updateCommitStatus(config)
                .then(() => {
                    assert.calledWith(githubMock.repos.createStatus, {
                        owner: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'success',
                        description: 'Everything looks good!',
                        context: 'Screwdriver/675/main',
                        target_url: 'https://foo.bar'
                    });
                });
        });

        it('promises to update commit status on failure', () => {
            config.buildStatus = 'FAILURE';

            return scm.updateCommitStatus(config)
                .then((result) => {
                    assert.deepEqual(result, data);

                    assert.calledWith(githubMock.repos.createStatus, {
                        owner: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'failure',
                        description: 'Did not work as expected.',
                        context: 'Screwdriver/675/main',
                        target_url: 'https://foo.bar'
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
                        owner: 'screwdriver-cd',
                        repo: 'models',
                        sha: config.sha,
                        state: 'success',
                        description: 'Everything looks good!',
                        context: 'Screwdriver/675/main',
                        target_url: 'https://foo.bar'
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
                token: 'somerandomtoken',
                url: 'https://foo.bar',
                jobName: 'main'
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

                    assert.strictEqual(stats['github:github.com'].requests.total, 2);
                    assert.strictEqual(stats['github:github.com'].requests.timeouts, 0);
                    assert.strictEqual(stats['github:github.com'].requests.success, 2);
                    assert.strictEqual(stats['github:github.com'].requests.failure, 0);
                    assert.strictEqual(stats['github:github.com'].breaker.isClosed, true);
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
            ref: 'git@github.com:screwdriver-cd/models.git#pull/453/merge'
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
                        owner: 'screwdriver-cd',
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
                        owner: 'screwdriver-cd',
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
                        owner: 'screwdriver-cd',
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
                        owner: 'screwdriver-cd',
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
        let commonPullRequestParse;
        let testHeaders;

        beforeEach(() => {
            commonPullRequestParse = {
                branch: 'master',
                checkoutUrl: 'git@github.com:baxterthehacker/public-repo.git',
                prNum: 1,
                prRef: 'pull/1/merge',
                sha: '0d1a26e67d8f5eaf1f6ba5c57fc3c7d91ac0fd1c',
                type: 'pr',
                username: 'baxterthehacker2',
                hookId: '3c77bf80-9a2f-11e6-80d6-72f7fe03ea29',
                scmContext: 'github:github.com'
            };

            testHeaders = {
                'x-hub-signature': 'sha1=a72eab99ad7f36f582f224df8d735091b06f1802',
                'x-github-event': 'pull_request',
                'x-github-delivery': '3c77bf80-9a2f-11e6-80d6-72f7fe03ea29'
            };
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
                        username: 'baxterthehacker2',
                        lastCommitMessage: 'lastcommitmessage',
                        hookId: '3c77bf80-9a2f-11e6-80d6-72f7fe03ea29',
                        scmContext: 'github:github.com'
                    });
                });
        });

        it('resolves null for a pull request payload with an unsupported action', () => {
            testHeaders['x-hub-signature'] = 'sha1=4fe5c8f4a7e4b76a4bd46b4693e87dadf9bec110';

            return scm.parseHook(testHeaders, testPayloadBadAction)
                .then((result) => {
                    assert.isNull(result);
                });
        });

        it('parses a payload for a pull request event payload', () => {
            testHeaders['x-hub-signature'] = 'sha1=41d0508ffed278fde2fd5a84fd75c109a7039f90';

            return scm.parseHook(testHeaders, testPayloadOpen)
                .then((result) => {
                    commonPullRequestParse.action = 'opened';
                    assert.deepEqual(result, commonPullRequestParse);
                });
        });

        it('parses a payload for a pull request being closed', () => {
            testHeaders['x-hub-signature'] = 'sha1=2d51c3a4eaab65832c119ec3db951de54ec38736';

            return scm.parseHook(testHeaders, testPayloadClose)
                .then((result) => {
                    commonPullRequestParse.action = 'closed';
                    assert.deepEqual(result, commonPullRequestParse);
                });
        });

        it('parses a payload for a pull request being synchronized', () => {
            testHeaders['x-hub-signature'] = 'sha1=583afb7551c9bc412f7496bc840b027931e97846';

            return scm.parseHook(testHeaders, testPayloadSync)
                .then((result) => {
                    commonPullRequestParse.action = 'synchronized';
                    assert.deepEqual(result, commonPullRequestParse);
                });
        });

        it('resolves null when parsing an unsupported event payload', () => {
            testHeaders['x-github-event'] = 'ping';
            testHeaders['x-hub-signature'] = 'sha1=1b51a3f9f548fdacab52c0e83f9a63f8cbb4b591';

            return scm.parseHook(testHeaders, testPayloadPing)
                .then((result) => {
                    assert.isNull(result);
                });
        });

        it('rejects when signature is not valid', () => {
            testHeaders['x-hub-signature'] = 'sha1=25cebb8fff2c10ec8d0712e3ab0163218d375492';

            return scm.parseHook(testHeaders, testPayloadPing)
                .then(() => {
                    assert.fail('This should not fail the tests');
                })
                .catch((err) => {
                    assert.equal(err, 'Invalid x-hub-signature');
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
            owner: 'iAm'
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

        it('rejects when repo does not exist', () => {
            const notFoundError = new Error('not found');

            notFoundError.code = 404;

            githubMock.repos.get.yieldsAsync(notFoundError);

            return scm.parseUrl({
                checkoutUrl,
                token
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (err) => {
                assert.match(err.message, 'Cannot find repository');
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

        it('rejects when passed checkoutUrl of another host', () => {
            const message = 'This checkoutUrl is not supported for your current login host.';

            checkoutUrl = 'git@github.screwdriver.cd:iAm/theCaptain.git#boat';

            return scm.parseUrl({
                checkoutUrl,
                token
            }).then(() => {
                assert.fail('This should not fail the test');
            }, (err) => {
                assert.match(err.message, message);
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
                    username
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
                    username
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
                    username
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
                    owner: repoOwner,
                    repo: repoName,
                    sha
                });
                assert.calledWith(githubMock.users.getForUser, {
                    username
                });
            });
        });

        it('defaults author data to empty if author is missing', () => {
            githubMock.repos.getCommit.yieldsAsync(null, {
                commit: {
                    message: 'some commit message that is here'
                },
                author: null,
                html_url: 'https://link.to/commitDiff'
            });
            githubMock.users.getForUser.yieldsAsync();

            return scm.decorateCommit({
                scmUri,
                sha,
                token: 'tokenfordecoratecommit'
            }).then((data) => {
                assert.deepEqual(data, {
                    author: {
                        avatar: 'https://cd.screwdriver.cd/assets/unknown_user.png',
                        name: 'n/a',
                        url: 'https://cd.screwdriver.cd/',
                        username: 'n/a'
                    },
                    message: 'some commit message that is here',
                    url: 'https://link.to/commitDiff'
                });

                assert.calledWith(githubMock.repos.getById, {
                    id: scmId
                });
                assert.calledWith(githubMock.repos.getCommit, {
                    owner: repoOwner,
                    repo: repoName,
                    sha
                });
                assert.callCount(githubMock.users.getForUser, 0);
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
                    owner: 'banana',
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

    describe('getBellConfiguration', () => {
        it('returns a default configuration', () => (
            scm.getBellConfiguration().then((config) => {
                assert.deepEqual(config, {
                    'github:github.com': {
                        clientId: 'abcdefg',
                        clientSecret: 'hijklmno',
                        forceHttps: false,
                        isSecure: false,
                        provider: 'github',
                        cookie: 'github-github.com',
                        scope: [
                            'admin:repo_hook',
                            'read:org',
                            'repo:status'
                        ]
                    }
                });
            })
        ));

        it('returns configuration for github enterprise', () => {
            scm = new GithubScm({
                oauthClientId: 'abcdefg',
                oauthClientSecret: 'hijklmno',
                gheHost: 'github.screwdriver.cd',
                secret: 'somesecret'
            });

            return scm.getBellConfiguration().then((config) => {
                assert.deepEqual(config, {
                    'github:github.screwdriver.cd': {
                        clientId: 'abcdefg',
                        clientSecret: 'hijklmno',
                        config: {
                            uri: 'https://github.screwdriver.cd'
                        },
                        forceHttps: false,
                        isSecure: false,
                        provider: 'github',
                        cookie: 'github-github.screwdriver.cd',
                        scope: [
                            'admin:repo_hook',
                            'read:org',
                            'repo:status'
                        ]
                    }
                });
            });
        });

        it('add repo scope to support private repo', () => {
            scm = new GithubScm({
                oauthClientId: 'abcdefg',
                oauthClientSecret: 'hijklmno',
                gheHost: 'github.screwdriver.cd',
                secret: 'somesecret',
                privateRepo: true
            });

            return scm.getBellConfiguration().then((config) => {
                assert.deepEqual(config, {
                    'github:github.screwdriver.cd': {
                        clientId: 'abcdefg',
                        clientSecret: 'hijklmno',
                        config: {
                            uri: 'https://github.screwdriver.cd'
                        },
                        forceHttps: false,
                        isSecure: false,
                        provider: 'github',
                        cookie: 'github-github.screwdriver.cd',
                        scope: [
                            'admin:repo_hook',
                            'read:org',
                            'repo:status',
                            'repo'
                        ]
                    }
                });
            });
        });
    });

    describe('addWebhook', () => {
        const webhookConfig = {
            scmUri: 'github.com:1263:branchName',
            token: 'fakeToken',
            webhookUrl: 'https://somewhere.in/the/interwebs'
        };

        beforeEach(() => {
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'dolores/violentdelights'
            });
            githubMock.repos.getHooks.yieldsAsync(null, [{
                config: { url: 'https://somewhere.in/the/interwebs' },
                id: 783150
            }]);
        });

        it('add a hook', () => {
            githubMock.repos.getHooks.yieldsAsync(null, []);
            githubMock.repos.createHook.yieldsAsync(null);

            return scm.addWebhook(webhookConfig).then(() => {
                assert.calledWith(githubMock.authenticate, sinon.match({
                    token: 'fakeToken'
                }));
                assert.calledWith(githubMock.repos.getById, {
                    id: '1263'
                });
                assert.calledWith(githubMock.repos.createHook, {
                    active: true,
                    config: {
                        content_type: 'json',
                        secret: 'somesecret',
                        url: 'https://somewhere.in/the/interwebs'
                    },
                    events: ['push', 'pull_request'],
                    name: 'web',
                    owner: 'dolores',
                    repo: 'violentdelights'
                });
            });
        });

        it('updates a pre-existing hook', () => {
            githubMock.repos.editHook.yieldsAsync(null);

            return scm.addWebhook(webhookConfig).then(() => {
                assert.calledWith(githubMock.repos.getHooks, {
                    owner: 'dolores',
                    repo: 'violentdelights',
                    page: 1,
                    per_page: 30
                });
                assert.calledWith(githubMock.repos.editHook, {
                    active: true,
                    config: {
                        content_type: 'json',
                        secret: 'somesecret',
                        url: 'https://somewhere.in/the/interwebs'
                    },
                    events: ['push', 'pull_request'],
                    id: 783150,
                    name: 'web',
                    owner: 'dolores',
                    repo: 'violentdelights'
                });
            });
        });

        it('updates hook on a repo with a lot of other hooks', () => {
            const invalidHooks = [];

            for (let i = 0; i < 30; i += 1) {
                invalidHooks.push({});
            }

            githubMock.repos.getHooks.onCall(0).yieldsAsync(null, invalidHooks);
            githubMock.repos.editHook.yieldsAsync(null);

            return scm.addWebhook(webhookConfig).then(() => {
                assert.calledWith(githubMock.repos.getHooks, {
                    owner: 'dolores',
                    repo: 'violentdelights',
                    page: 2,
                    per_page: 30
                });
                assert.calledWith(githubMock.repos.editHook, {
                    active: true,
                    config: {
                        content_type: 'json',
                        secret: 'somesecret',
                        url: 'https://somewhere.in/the/interwebs'
                    },
                    events: ['push', 'pull_request'],
                    id: 783150,
                    name: 'web',
                    owner: 'dolores',
                    repo: 'violentdelights'
                });
            });
        });

        it('throws an error when failing to getHooks', () => {
            const testError = new Error('getHooksError');

            githubMock.repos.getHooks.yieldsAsync(testError);

            return scm.addWebhook(webhookConfig).then(assert.fail, (err) => {
                assert.equal(err, testError);
            });
        });

        it('throws an error when failing to createHook', () => {
            const testError = new Error('createHookError');

            githubMock.repos.getHooks.yieldsAsync(null, []);
            githubMock.repos.createHook.yieldsAsync(testError);

            return scm.addWebhook(webhookConfig).then(assert.fail, (err) => {
                assert.equal(err, testError);
            });
        });

        it('throws an error when failing to editHook', () => {
            const testError = new Error('editHookError');

            githubMock.repos.editHook.yieldsAsync(testError);

            return scm.addWebhook(webhookConfig).then(assert.fail, (err) => {
                assert.equal(err, testError);
            });
        });
    });

    describe('_getOpenedPRs', () => {
        const scmUri = 'github.com:111:branchName';
        const config = {
            scmUri,
            token: 'token'
        };

        beforeEach(() => {
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'repoOwner/repoName'
            });
        });

        it('returns a list of opened pull requests', () => {
            githubMock.pullRequests.getAll.yieldsAsync(null, [
                { number: 1 },
                { number: 2 }
            ]);

            return scm._getOpenedPRs(config).then((data) => {
                assert.deepEqual(data, [
                    {
                        name: 'PR-1',
                        ref: 'pull/1/merge'
                    },
                    {
                        name: 'PR-2',
                        ref: 'pull/2/merge'
                    }
                ]);

                assert.calledWith(githubMock.repos.getById, { id: '111' });
                assert.calledWith(githubMock.pullRequests.getAll, {
                    owner: 'repoOwner',
                    repo: 'repoName',
                    state: 'open'
                });
            });
        });

        it('rejects when failing to lookup the SCM URI information', () => {
            const testError = new Error('testError');

            githubMock.repos.getById.yieldsAsync(testError);

            return scm._getOpenedPRs(config).then(assert.fail, (err) => {
                assert.instanceOf(err, Error);
                assert.strictEqual(testError.message, err.message);
            });
        });

        it('rejects when failing to fetch opened pull requests', () => {
            const testError = new Error('testError');

            githubMock.pullRequests.getAll.yieldsAsync(testError);

            return scm._getOpenedPRs(config).then(assert.fail, (err) => {
                assert.instanceOf(err, Error);
                assert.strictEqual(testError.message, err.message);
            });
        });
    });

    describe('_getPrInfo', () => {
        const scmUri = 'github.com:111:branchName';
        const config = {
            scmUri,
            token: 'token',
            prNum: 1
        };
        const sha = 'ccc49349d3cffbd12ea9e3d41521480b4aa5de5f';

        beforeEach(() => {
            githubMock.repos.getById.yieldsAsync(null, {
                full_name: 'repoOwner/repoName'
            });
        });

        it('returns a pull request with the given prNum', () => {
            githubMock.pullRequests.get.yieldsAsync(null,
                { number: 1, head: { sha } }
            );

            return scm._getPrInfo(config).then((data) => {
                assert.deepEqual(data,
                    {
                        name: 'PR-1',
                        ref: 'pull/1/merge',
                        sha
                    }
                );

                assert.calledWith(githubMock.repos.getById, { id: '111' });
                assert.calledWith(githubMock.pullRequests.get, {
                    owner: 'repoOwner',
                    repo: 'repoName',
                    number: 1
                });
            });
        });

        it('rejects when failing to lookup the SCM URI information', () => {
            const testError = new Error('testError');

            githubMock.repos.getById.yieldsAsync(testError);

            return scm._getPrInfo(config).then(assert.fail, (err) => {
                assert.instanceOf(err, Error);
                assert.strictEqual(testError.message, err.message);
            });
        });

        it('rejects when failing to get the pull request', () => {
            const testError = new Error('testError');

            githubMock.pullRequests.get.yieldsAsync(testError);

            return scm._getPrInfo(config).then(assert.fail, (err) => {
                assert.instanceOf(err, Error);
                assert.strictEqual(testError.message, err.message);
            });
        });
    });

    describe('getScmContexts', () => {
        it('returns a default scmContext', () => {
            const result = scm.getScmContexts();

            return assert.deepEqual(result, ['github:github.com']);
        });

        it('returns a scmContext for github enterprise', () => {
            scm = new GithubScm({
                oauthClientId: 'abcdefg',
                oauthClientSecret: 'hijklmno',
                gheHost: 'github.screwdriver.cd',
                secret: 'somesecret'
            });

            const result = scm.getScmContexts();

            return assert.deepEqual(result, ['github:github.screwdriver.cd']);
        });
    });

    describe('canHandleWebhook', () => {
        let testHeaders;

        beforeEach(() => {
            testHeaders = {
                'x-hub-signature': 'sha1=a72eab99ad7f36f582f224df8d735091b06f1802',
                'x-github-event': 'pull_request',
                'x-github-delivery': '3c77bf80-9a2f-11e6-80d6-72f7fe03ea29'
            };
        });

        it('returns a true for a pull request event payload', () => {
            testHeaders['x-hub-signature'] = 'sha1=41d0508ffed278fde2fd5a84fd75c109a7039f90';

            return scm.canHandleWebhook(testHeaders, testPayloadOpen)
                .then((result) => {
                    assert.strictEqual(result, true);
                });
        });

        it('returns a true for a pull request being closed', () => {
            testHeaders['x-hub-signature'] = 'sha1=2d51c3a4eaab65832c119ec3db951de54ec38736';

            return scm.canHandleWebhook(testHeaders, testPayloadClose)
                .then((result) => {
                    assert.strictEqual(result, true);
                });
        });

        it('returns a true for a pull request being synchronized', () => {
            testHeaders['x-hub-signature'] = 'sha1=583afb7551c9bc412f7496bc840b027931e97846';

            return scm.canHandleWebhook(testHeaders, testPayloadSync)
                .then((result) => {
                    assert.strictEqual(result, true);
                });
        });

        it('returns a true for a push event payload', () => {
            testHeaders['x-github-event'] = 'push';

            return scm.canHandleWebhook(testHeaders, testPayloadPush)
                .then((result) => {
                    assert.strictEqual(result, true);
                });
        });

        it('returns a false when signature is not valid', () => {
            testHeaders['x-hub-signature'] = 'sha1=25cebb8fff2c10ec8d0712e3ab0163218d375492';

            return scm.canHandleWebhook(testHeaders, testPayloadPing)
                .then((result) => {
                    assert.strictEqual(result, false);
                });
        });

        it('returns a false when different github payload', () => {
            scm = new GithubScm({
                oauthClientId: 'abcdefg',
                oauthClientSecret: 'hijklmno',
                gheHost: 'github.screwdriver.cd',
                secret: 'somesecret'
            });

            testHeaders['x-hub-signature'] = 'sha1=41d0508ffed278fde2fd5a84fd75c109a7039f90';

            return scm.canHandleWebhook(testHeaders, testPayloadOpen)
                .then((result) => {
                    assert.strictEqual(result, false);
                });
        });
    });
});
