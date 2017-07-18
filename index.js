/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const Breaker = require('circuit-fuses');
const Github = require('github');
const hoek = require('hoek');
const joi = require('joi');
const schema = require('screwdriver-data-schema');
const Scm = require('screwdriver-scm-base');
const crypto = require('crypto');
const DEFAULT_AUTHOR = {
    avatar: 'https://cd.screwdriver.cd/assets/unknown_user.png',
    name: 'n/a',
    username: 'n/a',
    url: 'https://cd.screwdriver.cd/'
};
const MATCH_COMPONENT_BRANCH_NAME = 4;
const MATCH_COMPONENT_REPO_NAME = 3;
const MATCH_COMPONENT_USER_NAME = 2;
const MATCH_COMPONENT_HOST_NAME = 1;
const WEBHOOK_PAGE_SIZE = 30;
const STATE_MAP = {
    SUCCESS: 'success',
    RUNNING: 'pending',
    QUEUED: 'pending'
};
const DESCRIPTION_MAP = {
    SUCCESS: 'Everything looks good!',
    FAILURE: 'Did not work as expected.',
    ABORTED: 'Aborted mid-flight',
    RUNNING: 'Testing your code...',
    QUEUED: 'Looking for a place to park...'
};

/**
* Get repo information
* @method getInfo
* @param  {String}  scmUrl      scmUrl of the repo
* @return {Object}              An object with the user, repo, and branch
*/
function getInfo(scmUrl) {
    const matched = (schema.config.regex.CHECKOUT_URL).exec(scmUrl);

    // Check if regex did not pass
    if (!matched) {
        throw new Error(`Invalid scmUrl: ${scmUrl}`);
    }

    const branch = matched[MATCH_COMPONENT_BRANCH_NAME] || '#master';

    return {
        owner: matched[MATCH_COMPONENT_USER_NAME],
        repo: matched[MATCH_COMPONENT_REPO_NAME],
        host: matched[MATCH_COMPONENT_HOST_NAME],
        branch: branch.slice(1)
    };
}

class GithubScm extends Scm {
    /**
    * Github command to run
    * @method _githubCommand
    * @param  {Object}      options              An object that tells what command & params to run
    * @param  {String}      options.action       Github method. For example: get
    * @param  {String}      options.token        Github token used for authentication of requests
    * @param  {Object}      options.params       Parameters to run with
    * @param  {String}      [options.scopeType]  Type of request to make. Default is 'repos'
    * @param  {Function}    callback             Callback function from github API
    */
    _githubCommand(options, callback) {
        this.github.authenticate({
            type: 'oauth',
            token: options.token
        });
        const scopeType = options.scopeType || 'repos';

        this.github[scopeType][options.action](options.params, callback);
    }

    /**
    * Constructor
    * @method constructor
    * @param  {Object}  options                      Configuration options
    * @param  {Boolean} [options.privateRepo=false]  Request 'repo' scope, which allows read/write access for public & private repos
    * @param  {String}  [options.gheHost=null]       If using GitHub Enterprise, the host/port of the deployed instance
    * @param  {String}  [options.gheProtocol=https]  If using GitHub Enterprise, the protocol to use
    * @param  {String}  [options.username=sd-buildbot]           GitHub username for checkout
    * @param  {String}  [options.email=dev-null@screwdriver.cd]  GitHub user email for checkout
    * @param  {Boolean} [options.https=false]        Is the Screwdriver API running over HTTPS
    * @param  {String}  options.oauthClientId        OAuth Client ID provided by GitHub application
    * @param  {String}  options.oauthClientSecret    OAuth Client Secret provided by GitHub application
    * @param  {Object}  [options.fusebox={}]         Circuit Breaker configuration
    * @param  {String}  options.secret               Secret to validate the signature of webhook events
    * @return {GithubScm}
    */
    constructor(config = {}) {
        super();

        // Validate configuration
        this.config = joi.attempt(config, joi.object().keys({
            privateRepo: joi.boolean().optional().default(false),
            gheProtocol: joi.string().optional().default('https'),
            gheHost: joi.string().optional().description('GitHub Enterpise host'),
            username: joi.string().optional().default('sd-buildbot'),
            email: joi.string().optional().default('dev-null@screwdriver.cd'),
            https: joi.boolean().optional().default(false),
            oauthClientId: joi.string().required(),
            oauthClientSecret: joi.string().required(),
            fusebox: joi.object().default({}),
            secret: joi.string().required()
        }).unknown(true), 'Invalid config for GitHub');

        const githubConfig = {};

        if (this.config.gheHost) {
            githubConfig.host = this.config.gheHost;
            githubConfig.protocol = this.config.gheProtocol;
            githubConfig.pathPrefix = '/api/v3';
        }
        this.github = new Github(githubConfig);

        // eslint-disable-next-line no-underscore-dangle
        this.breaker = new Breaker(this._githubCommand.bind(this), {
            // Do not retry when there is a 404 error
            shouldRetry: err => err && err.code !== 404,
            retry: this.config.fusebox.retry,
            breaker: this.config.fusebox.breaker
        });
    }

    /**
     * Look up a repo by SCM URI
     * @method lookupScmUri
     * @param  {Object}     config Config object
     * @param  {Object}     config.scmUri The SCM URI to look up relevant info
     * @param  {Object}     config.token  Service token to authenticate with Github
     * @return {Promise}                  Resolves to an object containing
     *                                    repository-related information
     */
    lookupScmUri(config) {
        const [scmHost, scmId, scmBranch] = config.scmUri.split(':');

        return this.breaker.runCommand({
            action: 'getById',
            token: config.token,
            params: { id: scmId }
        }).then((data) => {
            const [repoOwner, repoName] = data.full_name.split('/');

            return {
                branch: scmBranch,
                host: scmHost,
                repo: repoName,
                owner: repoOwner
            };
        });
    }

    /**
     * Look up a webhook from a repo
     * @method _findWebhook
     * @param  {Object}     config
     * @param  {Object}     config.scmInfo      Data about repo
     * @param  {String}     config.token        Admin token for repo
     * @param  {Number}     config.page         pagination: page number to search next
     * @param  {String}     config.url          url for webhook notifications
     * @return {Promise}                        Resolves a list of hooks
     */
    _findWebhook(config) {
        return this.breaker.runCommand({
            action: 'getHooks',
            token: config.token,
            params: {
                owner: config.scmInfo.owner,
                repo: config.scmInfo.repo,
                page: config.page,
                per_page: WEBHOOK_PAGE_SIZE
            }
        }).then((hooks) => {
            const screwdriverHook = hooks.find(hook =>
                hoek.reach(hook, 'config.url') === config.url
            );

            if (!screwdriverHook && hooks.length === WEBHOOK_PAGE_SIZE) {
                config.page += 1;

                return this._findWebhook(config);
            }

            return screwdriverHook;
        });
    }

    /**
     * Create or edit a webhook (edits if hookInfo exists)
     * @method _createWebhook
     * @param  {Object}     config
     * @param  {Object}     [config.hookInfo]   Information about a existing webhook
     * @param  {Object}     config.scmInfo      Information about the repo
     * @param  {String}     config.token        admin token for repo
     * @param  {String}     config.url          url for webhook notifications
     * @return {Promise}                        resolves when complete
     */
    _createWebhook(config) {
        let action = 'createHook';
        const params = {
            active: true,
            events: ['push', 'pull_request'],
            owner: config.scmInfo.owner,
            repo: config.scmInfo.repo,
            name: 'web',
            config: {
                content_type: 'json',
                secret: this.config.secret,
                url: config.url
            }
        };

        if (config.hookInfo) {
            action = 'editHook';
            Object.assign(params, { id: config.hookInfo.id });
        }

        return this.breaker.runCommand({
            action,
            token: config.token,
            params
        });
    }

    /**
     * Adds the Screwdriver webhook to the Github repository
     * @method _addWebhook
     * @param  {Object}    config            Config object
     * @param  {String}    config.scmUri     The SCM URI to add the webhook to
     * @param  {String}    config.token      Service token to authenticate with Github
     * @param  {String}    config.webhookUrl The URL to use for the webhook notifications
     * @return {Promise}                     Resolve means operation completed without failure.
     */
    _addWebhook(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            this._findWebhook({
                scmInfo,
                url: config.webhookUrl,
                page: 1,
                token: config.token
            }).then(hookInfo =>
                this._createWebhook({
                    hookInfo,
                    scmInfo,
                    token: config.token,
                    url: config.webhookUrl
                })
            )
        );
    }

    /**
     * Checkout the source code from a repository; resolves as an object with checkout commands
     * @method getCheckoutCommand
     * @param  {Object}    config
     * @param  {String}    config.branch        Pipeline branch
     * @param  {String}    config.host          Scm host to checkout source code from
     * @param  {String}    config.org           Scm org name
     * @param  {String}    config.repo          Scm repo name
     * @param  {String}    config.sha           Commit sha
     * @param  {String}    [config.prRef]       PR reference (can be a PR branch or reference)
     * @return {Promise}
     */
    _getCheckoutCommand(config) {
        const checkoutUrl = `${config.host}/${config.org}/${config.repo}`; // URL for https
        const sshCheckoutUrl = `git@${config.host}:${config.org}/${config.repo}`; // URL for ssh
        const checkoutRef = config.prRef ? config.branch : config.sha; // if PR, use pipeline branch
        const command = [];

        // Git clone
        command.push(`echo Cloning ${checkoutUrl}, on branch ${config.branch}`);
        command.push('if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
            `then export SCM_URL=${sshCheckoutUrl}; ` +
            'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
            `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
            `else export SCM_URL=https://${checkoutUrl}; fi`);
        command.push(`git clone --quiet --progress --branch ${config.branch} `
            + '$SCM_URL $SD_SOURCE_DIR');
        // Reset to SHA
        command.push(`git reset --hard ${checkoutRef}`);
        command.push(`echo Reset to ${checkoutRef}`);
        // Set config
        command.push('echo Setting user name and user email');
        command.push(`git config user.name ${this.config.username}`);
        command.push(`git config user.email ${this.config.email}`);

        // For pull requests
        if (config.prRef) {
            const prRef = config.prRef.replace('merge', 'head:pr');

            // Fetch a pull request
            command.push(`echo Fetching PR and merging with ${config.branch}`);
            command.push(`git fetch origin ${prRef}`);
            // Merge a pull request with pipeline branch
            command.push(`git merge --no-edit ${config.sha}`);
        }

        return Promise.resolve({
            name: 'sd-checkout-code',
            command: command.join(' && ')
        });
    }

    /**
     * Get a list of objects which consist of opened PR names and refs
     * @method _getOpenedPRs
     * @param  {Object}      config
     * @param  {String}      config.scmUri  The scmUri to get opened PRs from
     * @param  {String}      config.token   The token used to authenticate with the SCM
     * @return {Promise}
     */
    _getOpenedPRs(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            this.breaker.runCommand({
                action: 'getAll',
                scopeType: 'pullRequests',
                token: config.token,
                params: {
                    owner: scmInfo.owner,
                    repo: scmInfo.repo,
                    state: 'open'
                }
            })
        ).then(pullRequests =>
            pullRequests.map(pullRequestInfo => ({
                name: `PR-${pullRequestInfo.number}`,
                ref: `pull/${pullRequestInfo.number}/merge`
            }))
        );
    }

    /**
    * Get a owners permissions on a repository
    * @method _getPermissions
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUri     The scmUri to get permissions on
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getPermissions(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            this.breaker.runCommand({
                action: 'get',
                token: config.token,
                params: {
                    repo: scmInfo.repo,
                    owner: scmInfo.owner
                }
            })
        ).then(data => data.permissions);
    }

    /**
     * Get a commit sha for a specific repo#branch or pull request
     * @method getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get commit sha of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  [config.prNum]    The PR number used to fetch the PR
     * @return {Promise}
     */
    _getCommitSha(config) {
        if (config.prNum) {
            return this._getPrInfo(config).then(pr => pr.sha);
        }

        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            this.breaker.runCommand({
                action: 'getBranch',
                token: config.token,
                params: {
                    branch: scmInfo.branch,
                    host: scmInfo.host,
                    repo: scmInfo.repo,
                    owner: scmInfo.owner
                }
            })
        ).then(data => data.commit.sha);
    }

    /**
    * Update the commit status for a given repo and sha
    * @method updateCommitStatus
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUri       The scmUri to get permissions on
    * @param  {String}   config.sha          The sha to apply the status to
    * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   config.jobName      Optional name of the job that finished
    * @param  {String}   config.url          Target url
    * @param  {Number}   config.pipelineId   Pipeline Id
    * @return {Promise}
    */
    _updateCommitStatus(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then((scmInfo) => {
            let context = `Screwdriver/${config.pipelineId}/`;

            context += /^PR/.test(config.jobName) ? 'PR' : config.jobName;

            const params = {
                context,
                description: DESCRIPTION_MAP[config.buildStatus],
                repo: scmInfo.repo,
                sha: config.sha,
                state: STATE_MAP[config.buildStatus] || 'failure',
                owner: scmInfo.owner,
                target_url: config.url
            };

            return this.breaker.runCommand({
                action: 'createStatus',
                token: config.token,
                params
            });
        });
    }

    /**
    * Fetch content of a file from github
    * @method getFile
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUri       The scmUri to get permissions on
    * @param  {String}   config.path         The file in the repo to fetch
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   config.ref          The reference to the SCM, either branch or sha
    * @return {Promise}
    */
    _getFile(config) {
        return this.lookupScmUri(config).then(scmInfo =>
            this.breaker.runCommand({
                action: 'getContent',
                token: config.token,
                params: {
                    owner: scmInfo.owner,
                    repo: scmInfo.repo,
                    path: config.path,
                    ref: config.ref || scmInfo.branch
                }
            })
        ).then((data) => {
            if (data.type !== 'file') {
                throw new Error(`Path (${config.path}) does not point to file`);
            }

            return new Buffer(data.content, data.encoding).toString();
        });
    }

    /**
    * Retrieve stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return this.breaker.stats();
    }

    /**
     * Get id of a specific repo
     * @method _getRepoId
     * @param  {Object}   scmInfo               The result of getScmInfo
     * @param  {String}   token                 The token used to authenticate to the SCM
     * @param  {String}   config.checkoutUrl    The checkoutUrl to parse
     * @return {Promise}                        Resolves to the result object of GitHub repository API
     */
    _getRepoId(scmInfo, token, checkoutUrl) {
        return this.breaker.runCommand({
            action: 'get',
            token,
            params: scmInfo })
        .then(data => data.id)
        .catch((err) => {
            if (err.code === 404) {
                throw new Error(`Cannot find repository ${checkoutUrl}`);
            }

            throw new Error(err);
        });
    }

    /**
     * Decorate the author based on the Github service
     * @method _decorateAuthor
     * @param  {Object}        config          Configuration object
     * @param  {Object}        config.token    Service token to authenticate with Github
     * @param  {Object}        config.username Username to query more information for
     * @return {Promise}
     */
    _decorateAuthor(config) {
        return this.breaker.runCommand({
            action: 'getForUser',
            scopeType: 'users',
            token: config.token,
            params: { username: config.username }
        }).then((data) => {
            const name = data.name ? data.name : data.login;

            return {
                avatar: data.avatar_url,
                name,
                username: data.login,
                url: data.html_url
            };
        });
    }

    /**
     * Decorate the commit based on the repository
     * @method _decorateCommit
     * @param  {Object}        config        Configuration object
     * @param  {Object}        config.scmUri SCM URI the commit belongs to
     * @param  {Object}        config.sha    SHA to decorate data with
     * @param  {Object}        config.token  Service token to authenticate with Github
     * @return {Promise}
     */
    _decorateCommit(config) {
        const commitLookup = this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            this.breaker.runCommand({
                action: 'getCommit',
                token: config.token,
                params: {
                    owner: scmInfo.owner,
                    repo: scmInfo.repo,
                    sha: config.sha
                }
            })
        );
        const authorLookup = commitLookup.then((commitData) => {
            if (!commitData.author) {
                return DEFAULT_AUTHOR;
            }

            return this.decorateAuthor({
                token: config.token,
                username: commitData.author.login
            });
        });

        return Promise.all([
            commitLookup,
            authorLookup
        ]).then(([commitData, authorData]) =>
            ({
                author: authorData,
                message: commitData.commit.message,
                url: commitData.html_url
            })
        );
    }

    /**
     * Decorate a given SCM URI with additional data to better display
     * related information. If a branch suffix is not provided, it will default
     * to the master branch
     * @method _decorateUrl
     * @param  {Config}    config        Configuration object
     * @param  {String}    config.scmUri The SCM URI the commit belongs to
     * @param  {String}    config.token  Service token to authenticate with Github
     * @return {Promise}
     */
    _decorateUrl(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then((scmInfo) => {
            const baseUrl = `${scmInfo.host}/${scmInfo.owner}/${scmInfo.repo}`;

            return {
                branch: scmInfo.branch,
                name: `${scmInfo.owner}/${scmInfo.repo}`,
                url: `https://${baseUrl}/tree/${scmInfo.branch}`
            };
        });
    }

    /**
     * Check validity of github webhook event signature
     * @method _checkSignature
     * @param   {String}    secret      The secret used to sign the payload
     * @param   {String}    payload     The payload of the webhook event
     * @param   {String}    signature   The signature of the webhook event
     * @returns {boolean}
     */
    _checkSignature(secret, payload, signature) {
        const hmac = crypto.createHmac('sha1', secret);

        hmac.setEncoding('hex');
        hmac.write(JSON.stringify(payload), 'utf-8');
        hmac.end();

        const sha = hmac.read();
        const hash = `sha1=${sha}`;

        return hash === signature;
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     * @method _parseHook
     * @param  {Object}  payloadHeaders  The request headers associated with the
     *                                   webhook payload
     * @param  {Object}  webhookPayload  The webhook payload received from the
     *                                   SCM service.
     * @return {Promise}                 A key-map of data related to the received
     *                                   payload
     */
    _parseHook(payloadHeaders, webhookPayload) {
        const signature = payloadHeaders['x-hub-signature'];

        // eslint-disable-next-line no-underscore-dangle
        if (!this._checkSignature(this.config.secret, webhookPayload, signature)) {
            return Promise.reject('Invalid x-hub-signature');
        }

        const type = payloadHeaders['x-github-event'];
        const hookId = payloadHeaders['x-github-delivery'];
        const checkoutUrl = hoek.reach(webhookPayload, 'repository.ssh_url');
        const scmContexts = this._getScmContexts();

        switch (type) {
        case 'pull_request': {
            let action = hoek.reach(webhookPayload, 'action');
            const prNum = hoek.reach(webhookPayload, 'pull_request.number');

            // Possible actions
            // "opened", "closed", "reopened", "synchronize",
            // "assigned", "unassigned", "labeled", "unlabeled", "edited"
            if (!['opened', 'reopened', 'synchronize', 'closed'].includes(action)) {
                return Promise.resolve(null);
            }

            if (action === 'synchronize') {
                action = 'synchronized';
            }

            return Promise.resolve({
                action,
                branch: hoek.reach(webhookPayload, 'pull_request.base.ref'),
                checkoutUrl,
                prNum,
                prRef: `pull/${prNum}/merge`,
                sha: hoek.reach(webhookPayload, 'pull_request.head.sha'),
                type: 'pr',
                username: hoek.reach(webhookPayload, 'sender.login'),
                hookId,
                scmContext: scmContexts[0]
            });
        }
        case 'push':
            return Promise.resolve({
                action: 'push',
                branch: hoek.reach(webhookPayload, 'ref').replace(/^refs\/heads\//, ''),
                checkoutUrl,
                sha: hoek.reach(webhookPayload, 'after'),
                type: 'repo',
                username: hoek.reach(webhookPayload, 'sender.login'),
                lastCommitMessage: hoek.reach(webhookPayload, 'head_commit.message') || '',
                hookId,
                scmContext: scmContexts[0]
            });
        default:
            return Promise.resolve(null);
        }
    }

    /**
     * Parses a SCM URL into a screwdriver-representable ID
     *
     * 'token' is required, since it is necessary to lookup the SCM ID by
     * communicating with said SCM service.
     * @method _parseUrl
     * @param  {Object}     config              Config object
     * @param  {String}     config.checkoutUrl  The checkoutUrl to parse
     * @param  {String}     config.token        The token used to authenticate to the SCM service
     * @return {Promise}                        Resolves to an ID of 'serviceName:repoId:branchName'
     */
    _parseUrl(config) {
        return new Promise((resolve) => {
            resolve(getInfo(config.checkoutUrl));
        }).then(scmInfo =>
            // eslint-disable-next-line no-underscore-dangle
            this._getRepoId(scmInfo, config.token, config.checkoutUrl)
                .then(repoId => `${scmInfo.host}:${repoId}:${scmInfo.branch}`)
        );
    }

    /**
     * Return a valid Bell configuration (for OAuth)
     * @method _getBellConfiguration
     * @return {Promise}
     */
    _getBellConfiguration() {
        const scope = ['admin:repo_hook', 'read:org', 'repo:status'];
        const bellConfig = {
            provider: 'github',
            clientId: this.config.oauthClientId,
            clientSecret: this.config.oauthClientSecret,
            scope: this.config.privateRepo === true ? scope.concat('repo') : scope,
            isSecure: this.config.https,
            forceHttps: this.config.https
        };

        if (this.config.gheHost) {
            bellConfig.config = {
                uri: `${this.config.gheProtocol}://${this.config.gheHost}`
            };
        }

        return Promise.resolve(bellConfig);
    }

    /**
     * Resolve a pull request object based on the config
     * @method getPrRef
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get PR info of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  config.prNum      The PR number used to fetch the PR
     * @return {Promise}
     */
    _getPrInfo(config) {
        return this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        }).then(scmInfo =>
            this.breaker.runCommand({
                action: 'get',
                scopeType: 'pullRequests',
                token: config.token,
                params: {
                    owner: scmInfo.owner,
                    repo: scmInfo.repo,
                    number: config.prNum
                }
            })
        ).then(pullRequestInfo => ({
            name: `PR-${pullRequestInfo.number}`,
            ref: `pull/${pullRequestInfo.number}/merge`,
            sha: pullRequestInfo.head.sha
        }));
    }

    /**
     * Get an array of scm context (e.g. github.com)
     * @method getScmContext
     * @return {Array}
     */
    _getScmContexts() {
        const contextName = this.config.gheHost
            ? [`github:${this.config.gheHost}`]
            : ['github.com'];

        return contextName;
    }

    /**
     * Determin if a scm module can handle the received webhook
     * @method canHandleWebhook
     * @param {Object}    headers    The request headers associated with the webhook payload
     * @param {Object}    payload    The webhook payload received from the SCM service
     * @return {Promise}
     */
    _canHandleWebhook(headers, payload) {
        return this._parseHook(headers, payload)
            .then((result) => {
                Promise.resolve(result !== null);
            }).catch(() => {
                Promise.relolve(false);
            });
    }
}

module.exports = GithubScm;
