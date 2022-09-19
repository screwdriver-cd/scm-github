/* eslint no-underscore-dangle: ["error", { "allowAfterThis": true }] */

'use strict';

const Breaker = require('circuit-fuses').breaker;
const { Octokit } = require('@octokit/rest');
const { verify } = require('@octokit/webhooks');
const hoek = require('@hapi/hoek');
const Path = require('path');
const joi = require('joi');
const keygen = require('ssh-keygen');
const schema = require('screwdriver-data-schema');
const CHECKOUT_URL_REGEX = schema.config.regex.CHECKOUT_URL;
const PR_COMMENTS_REGEX = /^.+pipelines\/(\d+)\/builds.+ ([\w-:]+)$/;
const Scm = require('screwdriver-scm-base');
const logger = require('screwdriver-logger');
const DEFAULT_AUTHOR = {
    avatar: 'https://cd.screwdriver.cd/assets/unknown_user.png',
    name: 'n/a',
    username: 'n/a',
    url: 'https://cd.screwdriver.cd/'
};
const MATCH_COMPONENT_ROOTDIR_NAME = 5;
const MATCH_COMPONENT_BRANCH_NAME = 4;
const MATCH_COMPONENT_REPO_NAME = 3;
const MATCH_COMPONENT_USER_NAME = 2;
const MATCH_COMPONENT_HOST_NAME = 1;
const WEBHOOK_PAGE_SIZE = 30;
const BRANCH_PAGE_SIZE = 100;
const PR_FILES_PAGE_SIZE = 100;
const POLLING_INTERVAL = 0.2;
const POLLING_MAX_ATTEMPT = 10;
const STATE_MAP = {
    SUCCESS: 'success',
    PENDING: 'pending',
    FAILURE: 'failure'
};
const DESCRIPTION_MAP = {
    SUCCESS: 'Everything looks good!',
    FAILURE: 'Did not work as expected.',
    PENDING: 'Parked it as Pending...'
};
const PERMITTED_RELEASE_EVENT = ['published'];

const DEPLOY_KEY_GENERATOR_CONFIG = {
    DEPLOY_KEYS_FILE: `${__dirname}/keys_rsa`,
    DEPLOY_KEYS_FORMAT: 'PEM',
    DEPLOY_KEYS_PASSWORD: '',
    DEPLOY_KEY_TITLE: 'sd@screwdriver.cd'
};
const DEFAULT_BRANCH = 'main';

/**
 * Escape quotes (single quote) for single quote enclosure
 * @param {String} command escape command
 * @returns {String}
 */
function escapeForSingleQuoteEnclosure(command) {
    return command.replace(/'/g, `'"'"'`);
}

/**
 * Escape quotes (double or back quote) for double quote enclosure
 * @param {String} command escape command
 * @returns {String}
 */
function escapeForDoubleQuoteEnclosure(command) {
    return command.replace(/"/g, '\\"').replace(/`/g, '\\`');
}

/**
 * Throw error with error code
 * @param {Number} errorCode   Error code
 * @param {String} errorReason Error message
 * @throws {Error}             Throws error
 */
function throwError(errorReason, errorCode = 500) {
    const err = new Error(errorReason);

    err.statusCode = errorCode;
    throw err;
}

/**
 * Get repo information
 * @method getInfo
 * @param  {String}  scmUrl      scmUrl of the repo
 * @param  {String}  [rootDir]   Root dir of the pipeline
 * @return {Object}              An object with the owner, repo, host, branch, and rootDir
 */
function getInfo(scmUrl, rootDir) {
    const matched = schema.config.regex.CHECKOUT_URL.exec(scmUrl);

    // Check if regex did not pass
    if (!matched) {
        throwError(`Invalid scmUrl: ${scmUrl}`, 400);
    }

    const branch = matched[MATCH_COMPONENT_BRANCH_NAME];
    const rootDirFromScmUrl = matched[MATCH_COMPONENT_ROOTDIR_NAME];

    return {
        owner: matched[MATCH_COMPONENT_USER_NAME],
        repo: matched[MATCH_COMPONENT_REPO_NAME],
        host: matched[MATCH_COMPONENT_HOST_NAME],
        branch: branch ? branch.slice(1) : undefined,
        rootDir: rootDir || (rootDirFromScmUrl ? rootDirFromScmUrl.slice(1) : undefined)
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
     * @param  {String}      [options.route]      Route for octokit.request()
     * @param  {Function}    callback             Callback function from github API
     */
    _githubCommand(options, callback) {
        const config = { auth: `token ${options.token}`, ...this.octokitConfig };
        const octokit = new Octokit(config);
        const scopeType = options.scopeType || 'repos';

        if (scopeType === 'request' || scopeType === 'paginate') {
            // for deprecation of 'octokit.repos.getById({id})'
            // ref: https://github.com/octokit/rest.js/releases/tag/v16.0.1
            // octokit return response code as `response.status`, but screwdriver usually use `response.statusCode`
            octokit[scopeType](options.route, options.params)
                .then(response => {
                    response.statusCode = response.status;
                    callback(null, response);
                })
                .catch(err => {
                    err.statusCode = err.status;
                    callback(err);
                });
        } else {
            octokit[scopeType][options.action](options.params)
                .then(response => {
                    response.statusCode = response.status;
                    callback(null, response);
                })
                .catch(err => {
                    err.statusCode = err.status;
                    callback(err);
                });
        }
    }

    /**
     * Constructor
     * @method constructor
     * @param  {Object}  config                      Configuration object
     * @param  {Boolean} [config.privateRepo=false]  Request 'repo' scope, which allows read/write access for public & private repos
     * @param  {String}  [config.gheHost=null]       If using GitHub Enterprise, the host/port of the deployed instance
     * @param  {String}  [config.gheProtocol=https]  If using GitHub Enterprise, the protocol to use
     * @param  {String}  [config.username=sd-buildbot]           GitHub username for checkout
     * @param  {String}  [config.email=dev-null@screwdriver.cd]  GitHub user email for checkout
     * @param  {Object}  [options.readOnly={}]       Read-only SCM instance config with: enabled, username, accessToken, cloneType
     * @param  {Boolean} [config.https=false]        Is the Screwdriver API running over HTTPS
     * @param  {String}  config.oauthClientId        OAuth Client ID provided by GitHub application
     * @param  {String}  config.oauthClientSecret    OAuth Client Secret provided by GitHub application
     * @param  {Object}  [config.fusebox={}]         Circuit Breaker configuration
     * @param  {String}  config.secret               Secret to validate the signature of webhook events
     * @return {GithubScm}
     */
    constructor(config = {}) {
        super();

        // Validate configuration
        this.config = joi.attempt(
            config,
            joi
                .object()
                .keys({
                    privateRepo: joi
                        .boolean()
                        .optional()
                        .default(false),
                    gheProtocol: joi
                        .string()
                        .optional()
                        .default('https'),
                    gheHost: joi
                        .string()
                        .optional()
                        .description('GitHub Enterpise host'),
                    username: joi
                        .string()
                        .optional()
                        .default('sd-buildbot'),
                    email: joi
                        .string()
                        .optional()
                        .default('dev-null@screwdriver.cd'),
                    commentUserToken: joi
                        .string()
                        .optional()
                        .description('Token for PR comments'),
                    autoDeployKeyGeneration: joi
                        .boolean()
                        .optional()
                        .default(false),
                    readOnly: joi
                        .object()
                        .keys({
                            enabled: joi.boolean().optional(),
                            username: joi.string().optional(),
                            accessToken: joi.string().optional(),
                            cloneType: joi
                                .string()
                                .valid('https', 'ssh')
                                .optional()
                                .default('https')
                        })
                        .optional()
                        .default({}),
                    https: joi
                        .boolean()
                        .optional()
                        .default(false),
                    oauthClientId: joi.string().required(),
                    oauthClientSecret: joi.string().required(),
                    fusebox: joi.object().default({}),
                    secret: joi.string().required()
                })
                .unknown(true),
            'Invalid config for GitHub'
        );

        this.octokitConfig = {};

        if (this.config.gheHost) {
            this.octokitConfig.baseUrl = `${this.config.gheProtocol}://${this.config.gheHost}/api/v3`;
        }

        // eslint-disable-next-line no-underscore-dangle
        this.breaker = new Breaker(this._githubCommand.bind(this), {
            // Do not retry when there is a 4XX error
            shouldRetry: err => err && err.statusCode && !(err.statusCode >= 400 && err.statusCode < 500),
            retry: this.config.fusebox.retry,
            breaker: this.config.fusebox.breaker
        });
    }

    /**
     * Look up a repo by SCM URI
     * @async  lookupScmUri
     * @param  {Object}     config
     * @param  {Object}     config.scmUri       The SCM URI to look up relevant info
     * @param  {Object}     [config.scmRepo]    The SCM repository to look up
     * @param  {Object}     config.token        Service token to authenticate with Github
     * @return {Promise}                        Resolves to an object containing repository-related information
     */
    async lookupScmUri({ scmUri, scmRepo, token }) {
        const [scmHost, scmId, scmBranch, rootDir] = scmUri.split(':');

        let repoFullName;
        let defaultBranch;
        let privateRepo;

        if (scmRepo) {
            repoFullName = scmRepo.name;
            privateRepo = scmRepo.privateRepo || false;
        } else {
            try {
                const myHost = this.config.gheHost || 'github.com';

                if (scmHost !== myHost) {
                    throwError(
                        `Pipeline's scmHost ${scmHost} does not match with user's scmHost ${this.config.gheHost}`,
                        403
                    );
                }
                // https://github.com/octokit/rest.js/issues/163
                const repo = await this.breaker.runCommand({
                    scopeType: 'request',
                    route: 'GET /repositories/:id',
                    token,
                    params: { id: scmId }
                });

                repoFullName = repo.data.full_name;
                defaultBranch = repo.data.default_branch;
                privateRepo = repo.data.private;
            } catch (err) {
                logger.error('Failed to lookupScmUri: ', err);
                throw err;
            }
        }

        const [repoOwner, repoName] = repoFullName.split('/');

        return {
            branch: scmBranch || defaultBranch,
            host: scmHost,
            repo: repoName,
            owner: repoOwner,
            rootDir: rootDir || '',
            privateRepo
        };
    }

    /**
     * Promise to wait a certain number of seconds
     *
     * Might make this centralized for other tests to leverage
     *
     * @method promiseToWait
     * @param  {Number}      timeToWait  Number of seconds to wait before continuing the chain
     * @return {Promise}
     */
    promiseToWait(timeToWait) {
        return new Promise(resolve => {
            setTimeout(() => resolve(), timeToWait * 1000);
        });
    }

    /**
     * Wait computing mergeability
     * @async  waitPrMergeable
     * @param  {Object}   config
     * @param  {String}   config.scmUri     The scmUri to get PR info of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  config.prNum      The PR number used to fetch the PR
     * @param  {Integer}  count             The polling count
     * @return {Promise}                    Resolves to object containing result of computing mergeability
     *                                      The parameter of success exists for testing
     */
    async waitPrMergeability({ scmUri, token, prNum }, count) {
        try {
            const pullRequestInfo = await this.getPrInfo({ scmUri, token, prNum });

            if (pullRequestInfo.mergeable !== null && pullRequestInfo.mergeable !== undefined) {
                return { success: pullRequestInfo.mergeable, pullRequestInfo };
            }
            if (count >= POLLING_MAX_ATTEMPT - 1) {
                logger.warn(`Computing mergerbility did not finish. scmUri: ${scmUri}, prNum: ${prNum}`);

                return { success: false, pullRequestInfo };
            }

            await this.promiseToWait(POLLING_INTERVAL);
        } catch (err) {
            logger.error('Failed to getPrInfo: ', err);
            throw err;
        }

        return this.waitPrMergeability({ scmUri, token, prNum }, count + 1);
    }

    /**
     * Get all the comments of a particular Pull Request
     * @async  prComments
     * @param  {Object}   scmInfo           The information regarding SCM like repo, owner
     * @param  {Integer}  prNum             The PR number used to fetch the PR
     * @param  {String}   token             The PA token of the owner
     * @return {Promise}                    Resolves to object containing the list of comments of this PR
     */
    async prComments(scmInfo, prNum, token) {
        try {
            const { data } = await this.breaker.runCommand({
                action: 'listComments',
                scopeType: 'issues',
                token,
                params: {
                    issue_number: prNum,
                    owner: scmInfo.owner,
                    repo: scmInfo.repo
                }
            });

            return {
                comments: data
            };
        } catch (err) {
            logger.error('Failed to fetch PR comments: ', err);

            return null;
        }
    }

    /**
     * Edit a particular comment in the PR
     * @async  editPrComment
     * @param  {Integer}  commentId         The id of the particular comment to be edited
     * @param  {Object}   scmInfo           The information regarding SCM like repo, owner
     * @param  {String}   comment           The new comment body
     * @return {Promise}                    Resolves to object containing PR comment info
     */
    async editPrComment(commentId, scmInfo, comment) {
        try {
            const pullRequestComment = await this.breaker.runCommand({
                action: 'updateComment',
                scopeType: 'issues',
                token: this.config.commentUserToken, // need to use a token with public_repo permissions
                params: {
                    owner: scmInfo.owner,
                    repo: scmInfo.repo,
                    comment_id: commentId,
                    body: comment
                }
            });

            return pullRequestComment;
        } catch (err) {
            logger.error('Failed to edit PR comment: ', err);

            return null;
        }
    }

    /**
     * Generate a deploy private and public key pair
     * @async  generateDeployKey
     * @return {Promise}                    Resolves to object containing the public and private key pair
     */
    async generateDeployKey() {
        return new Promise((resolve, reject) => {
            const location = DEPLOY_KEY_GENERATOR_CONFIG.DEPLOY_KEYS_FILE;
            const comment = this.config.email;
            const password = DEPLOY_KEY_GENERATOR_CONFIG.DEPLOY_KEYS_PASSWORD;
            const format = DEPLOY_KEY_GENERATOR_CONFIG.DEPLOY_KEYS_FORMAT;

            keygen(
                {
                    location,
                    comment,
                    password,
                    read: true,
                    format
                },
                (err, keyPair) => {
                    if (err) {
                        logger.error('Failed to create keys: ', err);

                        return reject(err);
                    }

                    return resolve(keyPair);
                }
            );
        });
    }

    /**
     * Adds deploy public key to the github repo and returns the private key
     * @async  _addDeployKey
     * @param  {Object}     config
     * @param  {Object}     config.token        Admin token for repo
     * @param  {String}     config.checkoutUrl  The checkoutUrl to parse
     * @return {Promise}                        Resolves to the private key string
     */
    async _addDeployKey(config) {
        const { token, checkoutUrl } = config;
        const { owner, repo } = getInfo(checkoutUrl);
        const { pubKey, key } = await this.generateDeployKey();

        try {
            await this.breaker.runCommand({
                action: 'createDeployKey',
                token,
                params: {
                    owner,
                    repo,
                    title: DEPLOY_KEY_GENERATOR_CONFIG.DEPLOY_KEY_TITLE,
                    key: pubKey,
                    read_only: true
                }
            });

            return key;
        } catch (err) {
            logger.error('Failed to add token: ', err);
            throw err;
        }
    }

    /**
     * Get the webhook events mapping of screwdriver events and scm events
     * @method _getWebhookEventsMapping
     * @return {Object}     Returns a mapping of the events
     */
    _getWebhookEventsMapping() {
        return {
            pr: 'pull_request',
            release: 'release',
            tag: 'create',
            commit: 'push'
        };
    }

    /**
     * Look up a webhook from a repo
     * @async  _findWebhook
     * @param  {Object}     config
     * @param  {Object}     config.scmInfo      Data about repo
     * @param  {String}     config.token        Admin token for repo
     * @param  {Number}     config.page         Pagination: page number to search next
     * @param  {String}     config.url          Url for webhook notifications
     * @return {Promise}                        Resolves to a list of hooks
     */
    async _findWebhook(config) {
        try {
            const hooks = await this.breaker.runCommand({
                action: 'listWebhooks',
                token: config.token,
                params: {
                    owner: config.scmInfo.owner,
                    repo: config.scmInfo.repo,
                    page: config.page,
                    per_page: WEBHOOK_PAGE_SIZE
                }
            });

            const screwdriverHook = hooks.data.find(hook => hoek.reach(hook, 'config.url') === config.url);

            if (!screwdriverHook && hooks.data.length === WEBHOOK_PAGE_SIZE) {
                config.page += 1;

                return this._findWebhook(config);
            }

            return screwdriverHook;
        } catch (err) {
            logger.error('Failed to findWebhook: ', err);
            throw err;
        }
    }

    /**
     * Create or edit a webhook (edits if hookInfo exists)
     * @async _createWebhook
     * @param  {Object}     config
     * @param  {Object}     [config.hookInfo]   Information about a existing webhook
     * @param  {Object}     config.scmInfo      Information about the repo
     * @param  {String}     config.token        Admin token for repo
     * @param  {String}     config.url          Payload destination url for webhook notifications
     * @param  {String}     config.actions      Actions for the webhook events
     * @return {Promise}                        Resolves when complete
     */
    async _createWebhook(config) {
        let action = 'createWebhook';
        const params = {
            active: true,
            events: config.actions.length === 0 ? ['push', 'pull_request', 'create', 'release'] : config.actions,
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
            action = 'updateWebhook';
            Object.assign(params, { hook_id: config.hookInfo.id });
        }

        try {
            const hooks = await this.breaker.runCommand({
                action,
                token: config.token,
                params
            });

            return hooks.data;
        } catch (err) {
            logger.error('Failed to createWebhook: ', err);
            throw err;
        }
    }

    /**
     * Adds the Screwdriver webhook to the Github repository
     * @async  _addWebhook
     * @param  {Object}    config             Config object
     * @param  {String}    config.scmUri      The SCM URI to add the webhook to
     * @param  {String}    config.token       Service token to authenticate with Github
     * @param  {String}    config.webhookUrl  The URL to use for the webhook notifications
     * @param  {Array}     config.actions     The list of actions to be added for this webhook
     * @return {Promise}                      Resolve means operation completed without failure
     */
    async _addWebhook(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const hookInfo = await this._findWebhook({
            scmInfo,
            url: config.webhookUrl,
            page: 1,
            token: config.token
        });

        return this._createWebhook({
            hookInfo,
            scmInfo,
            actions: config.actions,
            token: config.token,
            url: config.webhookUrl
        });
    }

    /**
     * Get the command to check out source code from a repository
     * @async  _getCheckoutCommand
     * @param  {Object}    config
     * @param  {String}    config.branch         Pipeline branch
     * @param  {String}    config.host           Scm host to checkout source code from
     * @param  {String}    config.org            Scm org name
     * @param  {String}    config.repo           Scm repo name
     * @param  {String}    config.sha            Commit sha
     * @param  {String}    [config.commitBranch] Commit branch
     * @param  {String}    [config.prRef]        PR reference (can be a PR branch or reference)
     * @param  {String}    [config.rootDir]      Root directory
     * @param  {String}    [config.scmContext]   The scm context name
     * @param  {String}    [config.manifest]     Repo manifest URL (only defined if `screwdriver.cd/repoManifest` annotation is)
     * @param  {Object}    [config.parentConfig] Config for parent pipeline
     * @return {Promise}                         Resolves to object containing name and checkout commands
     */
    async _getCheckoutCommand(config) {
        const checkoutUrl = `${config.host}/${config.org}/${config.repo}`; // URL for https
        const sshCheckoutUrl = `git@${config.host}:${config.org}/${config.repo}`; // URL for ssh
        const branch = config.commitBranch ? config.commitBranch : config.branch; // use commit branch
        const singleQuoteEscapedBranch = escapeForSingleQuoteEnclosure(branch);
        const doubleQuoteEscapedBranch = escapeForDoubleQuoteEnclosure(singleQuoteEscapedBranch);
        const ghHost = config.host || 'github.com'; // URL for host to checkout from
        const gitConfigString = `
        Host ${ghHost}
            StrictHostKeyChecking no
        `; // config to permit SCM host for one time SSH connect
        const gitConfigB64 = Buffer.from(gitConfigString).toString('base64'); // encode the config to b64 to maintain format

        const command = [];

        command.push(
            // eslint-disable-next-line no-template-curly-in-string
            "export SD_GIT_WRAPPER=\"$(if [ `uname` = 'Darwin' ] || [ ${SD_HAB_ENABLED:-false} = 'false' ]; " +
                "then echo 'eval'; " +
                "else echo 'sd-step exec core/git'; fi)\""
        );

        command.push('if [ ! -z $SD_SCM_DEPLOY_KEY ]; then export SCM_CLONE_TYPE=ssh; fi');

        // Export environment variables
        command.push('echo Exporting environment variables');
        // Use read-only clone type
        if (hoek.reach(this.config, 'readOnly.enabled')) {
            if (hoek.reach(this.config, 'readOnly.cloneType') === 'ssh') {
                command.push(`export SCM_URL=${sshCheckoutUrl}`);
            } else {
                command.push(
                    'if [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
                        `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
                        `else export SCM_URL=https://${checkoutUrl}; fi`
                );
            }
        } else {
            command.push(
                'if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
                    `then export SCM_URL=${sshCheckoutUrl}; ` +
                    'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
                    `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
                    `else export SCM_URL=https://${checkoutUrl}; fi`
            );
        }
        command.push('export GIT_URL=$SCM_URL.git');
        // git 1.7.1 doesn't support --no-edit with merge, this should do same thing
        command.push('export GIT_MERGE_AUTOEDIT=no');

        // Configure git to use SSH based checkout
        // 1. Check for presence of deploy keys and clone type
        // 2. Store the deploy private key to /tmp/git_key
        // 3. Give it the necessary permissions and set env var to instruct git to use the key
        // 4. Add SCM host as a known host by adding config to ~/.ssh/config
        command.push(
            'if [ ! -z $SD_SCM_DEPLOY_KEY ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
                'then ' +
                'echo $SD_SCM_DEPLOY_KEY | base64 -d > /tmp/git_key && echo "" >> /tmp/git_key && ' +
                'chmod 600 /tmp/git_key && export GIT_SSH_COMMAND="ssh -i /tmp/git_key" && ' +
                `mkdir -p ~/.ssh/ && printf "%s\n" "${gitConfigB64}" | base64 -d >> ~/.ssh/config; fi`
        );

        // Set config
        command.push('echo Setting user name and user email');
        command.push(`$SD_GIT_WRAPPER "git config --global user.name ${this.config.username}"`);
        command.push(`$SD_GIT_WRAPPER "git config --global user.email ${this.config.email}"`);

        // Set final checkout dir, default to SD_SOURCE_DIR for backward compatibility
        command.push('export SD_CHECKOUT_DIR_FINAL=$SD_SOURCE_DIR');
        // eslint-disable-next-line max-len
        command.push('if [ ! -z $SD_CHECKOUT_DIR ]; then export SD_CHECKOUT_DIR_FINAL=$SD_CHECKOUT_DIR; fi');

        const shallowCloneCmd =
            'else if [ ! -z "$GIT_SHALLOW_CLONE_SINCE" ]; ' +
            'then export GIT_SHALLOW_CLONE_DEPTH_OPTION=' +
            '"--shallow-since=\'$GIT_SHALLOW_CLONE_SINCE\'"; ' +
            'else if [ -z $GIT_SHALLOW_CLONE_DEPTH ]; ' +
            'then export GIT_SHALLOW_CLONE_DEPTH=50; fi; ' +
            'export GIT_SHALLOW_CLONE_DEPTH_OPTION="--depth=$GIT_SHALLOW_CLONE_DEPTH"; fi; ' +
            'export GIT_SHALLOW_CLONE_BRANCH="--no-single-branch"; ' +
            'if [ "$GIT_SHALLOW_CLONE_SINGLE_BRANCH" = true ]; ' +
            'then export GIT_SHALLOW_CLONE_BRANCH=""; fi; ' +
            '$SD_GIT_WRAPPER ' +
            '"git clone $GIT_SHALLOW_CLONE_DEPTH_OPTION $GIT_SHALLOW_CLONE_BRANCH ';

        // Checkout config pipeline if this is a child pipeline
        if (config.parentConfig) {
            const parentCheckoutUrl = `${config.parentConfig.host}/${config.parentConfig.org}/${config.parentConfig.repo}`; // URL for https
            const parentSshCheckoutUrl = `git@${config.parentConfig.host}:${config.parentConfig.org}/${config.parentConfig.repo}`; // URL for ssh
            const parentBranch = config.parentConfig.branch;
            const escapedParentBranch = escapeForDoubleQuoteEnclosure(escapeForSingleQuoteEnclosure(parentBranch));
            const externalConfigDir = '$SD_ROOT_DIR/config';

            command.push(
                'if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
                    `then export CONFIG_URL=${parentSshCheckoutUrl}; ` +
                    'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
                    'then export CONFIG_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@' +
                    `${parentCheckoutUrl}; ` +
                    `else export CONFIG_URL=https://${parentCheckoutUrl}; fi`
            );

            command.push(`export SD_CONFIG_DIR=${externalConfigDir}`);

            // Git clone
            command.push(`echo 'Cloning external config repo ${parentCheckoutUrl}'`);
            command.push(
                `${'if [ ! -z $GIT_SHALLOW_CLONE ] && [ $GIT_SHALLOW_CLONE = false ]; ' +
                    'then $SD_GIT_WRAPPER ' +
                    `"git clone --recursive --quiet --progress --branch '${escapedParentBranch}' ` +
                    '$CONFIG_URL $SD_CONFIG_DIR"; '}${shallowCloneCmd}` +
                    `--recursive --quiet --progress --branch '${escapedParentBranch}' ` +
                    '$CONFIG_URL $SD_CONFIG_DIR"; fi'
            );

            // Reset to SHA
            command.push(`$SD_GIT_WRAPPER "git -C $SD_CONFIG_DIR reset --hard ${config.parentConfig.sha} --"`);
            command.push(`echo Reset external config repo to ${config.parentConfig.sha}`);
        }

        if (config.manifest) {
            const curlWrapper =
                '$(if curl --version > /dev/null 2>&1; ' +
                "then echo 'eval'; " +
                "else echo 'sd-step exec core/curl'; fi)";

            const repoDownloadUrl = 'https://storage.googleapis.com/git-repo-downloads/repo';
            const sdRepoReleasesUrl = 'https://api.github.com/repos/screwdriver-cd/sd-repo/releases/latest';
            const sdRepoDownloadUrl =
                'https://github.com/screwdriver-cd/sd-repo/releases/download/v[0-9.]*/sd-repo_linux_amd64';
            const sdRepoLatestFile = 'sd-repo-latest';

            command.push(`echo Checking out code using the repo manifest defined in ${config.manifest}`);

            // Get the repo binary
            command.push(`${curlWrapper} "curl -s ${repoDownloadUrl} > /usr/local/bin/repo"`);
            command.push('chmod a+x /usr/local/bin/repo');

            // Get the sd-repo binary and execute it
            command.push(
                `${curlWrapper} "curl -s ${sdRepoReleasesUrl} > | grep -E -o ${sdRepoDownloadUrl} > ${sdRepoLatestFile}"`
            );
            command.push(`${curlWrapper} "curl -Ls $(cat ${sdRepoLatestFile}) > /usr/local/bin/sd-repo"`);
            command.push('chmod a+x /usr/local/bin/sd-repo');
            command.push(`sd-repo -manifestUrl=${config.manifest} -sourceRepo=${config.org}/${config.repo}`);

            // sourcePath is the file created by `sd-repo` which contains the relative path to the source repository
            const sourcePath = 'sourcePath';

            // Export $SD_SOURCE_DIR to source repo path and cd into it
            command.push(
                `if [ $(cat ${sourcePath}) != "." ]; ` +
                    `then export SD_SOURCE_DIR=$SD_SOURCE_DIR/$(cat ${sourcePath}); fi`
            );
            command.push('cd $SD_SOURCE_DIR');
        } else {
            // Git clone
            command.push(`echo 'Cloning ${checkoutUrl}, on branch ${singleQuoteEscapedBranch}'`);
            command.push(
                `${'if [ ! -z $GIT_SHALLOW_CLONE ] && [ $GIT_SHALLOW_CLONE = false ]; ' +
                    'then $SD_GIT_WRAPPER ' +
                    `"git clone --recursive --quiet --progress --branch '${doubleQuoteEscapedBranch}' ` +
                    '$SCM_URL $SD_CHECKOUT_DIR_FINAL"; '}${shallowCloneCmd}` +
                    `--recursive --quiet --progress --branch '${doubleQuoteEscapedBranch}' ` +
                    '$SCM_URL $SD_CHECKOUT_DIR_FINAL"; fi'
            );

            // Reset to SHA
            if (config.prRef) {
                command.push(`$SD_GIT_WRAPPER "git reset --hard '${doubleQuoteEscapedBranch}' --"`);
                command.push(`echo 'Reset to ${singleQuoteEscapedBranch}'`);
            } else {
                command.push(`$SD_GIT_WRAPPER "git reset --hard '${config.sha}' --"`);
                command.push(`echo 'Reset to ${config.sha}'`);
            }
        }

        // For pull requests
        if (config.prRef) {
            const LOCAL_BRANCH_NAME = 'pr';
            const prRef = config.prRef.replace('merge', `head:${LOCAL_BRANCH_NAME}`);
            const baseRepo = config.prSource === 'fork' ? 'upstream' : 'origin';
            const prBranch = config.prBranchName;
            const singleQuoteEscapedPrBranch = escapeForSingleQuoteEnclosure(prBranch);

            // Fetch a pull request
            command.push(`echo 'Fetching PR ${prRef}'`);
            command.push(`$SD_GIT_WRAPPER "git fetch origin ${prRef}"`);

            command.push(`export PR_BASE_BRANCH_NAME='${singleQuoteEscapedBranch}'`);
            command.push(`export PR_BRANCH_NAME='${baseRepo}/${singleQuoteEscapedPrBranch}'`);

            command.push(`echo 'Checking out the PR branch ${singleQuoteEscapedPrBranch}'`);
            command.push(`$SD_GIT_WRAPPER "git checkout ${LOCAL_BRANCH_NAME}"`);
            command.push(`$SD_GIT_WRAPPER "git merge '${doubleQuoteEscapedBranch}'"`);
            command.push(`export GIT_BRANCH=origin/refs/${prRef}`);
        } else {
            command.push(`export GIT_BRANCH='origin/${singleQuoteEscapedBranch}'`);
        }

        if (!config.manifest) {
            // Init & Update submodule only when sd-repo is not used
            command.push('$SD_GIT_WRAPPER "git submodule init"');
            command.push('$SD_GIT_WRAPPER "git submodule update --recursive"');
            // cd into rootDir after merging
            if (config.rootDir) {
                command.push(`cd ${config.rootDir}`);
            }
        }

        return {
            name: 'sd-checkout-code',
            command: command.join(' && ')
        };
    }

    /**
     * Get a list of names and references of opened PRs
     * @async  _getOpenedPRs
     * @param  {Object}      config
     * @param  {String}      config.scmUri  The scmUri to get opened PRs from
     * @param  {String}      config.token   The token used to authenticate with the SCM
     * @return {Promise}                    Resolves to an array of objects storing opened PR names and refs
     */
    async _getOpenedPRs({ scmUri, token }) {
        const { owner, repo } = await this.lookupScmUri({
            scmUri,
            token
        });

        try {
            const pullRequests = await this.breaker.runCommand({
                action: 'list',
                scopeType: 'pulls',
                token,
                params: {
                    owner,
                    repo,
                    state: 'open',
                    per_page: 100
                }
            });

            return pullRequests.data.map(pullRequest => ({
                name: `PR-${pullRequest.number}`,
                ref: `pull/${pullRequest.number}/merge`,
                username: pullRequest.user.login,
                title: pullRequest.title,
                createTime: pullRequest.created_at,
                url: pullRequest.html_url,
                userProfile: pullRequest.user.html_url
            }));
        } catch (err) {
            logger.error('Failed to getOpenedPRs: ', err);
            throw err;
        }
    }

    /**
     * Get an owner's permissions on a repository
     * @async  _getPermissions
     * @param  {Object}   config
     * @param  {String}   config.scmUri      The scmUri to get permissions on
     * @param  {Object}   [config.scmRepo]   The SCM repo to look up
     * @param  {String}   config.token       The token used to authenticate to the SCM
     * @return {Promise}                     Resolves to the owner's repository permissions
     */
    async _getPermissions(config) {
        const lookupConfig = {
            scmUri: config.scmUri,
            token: config.token
        };

        if (config.scmRepo) {
            lookupConfig.scmRepo = config.scmRepo;
        }

        try {
            const scmInfo = await this.lookupScmUri(lookupConfig);

            const repo = await this.breaker.runCommand({
                action: 'get',
                token: config.token,
                params: {
                    owner: scmInfo.owner,
                    repo: scmInfo.repo
                }
            });

            return repo.data.permissions;
        } catch (err) {
            // Suspended user
            if (err.message.match(/suspend/i)) {
                logger.info(`User's account suspended for ${config.scmUri}, it will be removed from pipeline admins.`);

                return { admin: false, push: false, pull: false };
            }

            logger.error('Failed to getPermissions: ', err);
            throw err;
        }
    }

    /**
     * Get a users permissions on an organization
     * @method _getOrgPermissions
     * @param  {Object}   config                  Configuration
     * @param  {String}   config.organization     The organization to get permissions on
     * @param  {String}   config.username         The user to check against
     * @param  {String}   config.token            The token used to authenticate to the SCM
     * @param  {String}   [config.scmContext]     The scm context name
     * @return {Promise}
     */
    async _getOrgPermissions(config) {
        const result = {
            admin: false,
            member: false
        };

        try {
            const permission = await this.breaker.runCommand({
                action: 'getMembershipForAuthenticatedUser',
                scopeType: 'orgs',
                token: config.token,
                params: {
                    org: config.organization
                }
            });
            const { role } = permission.data;
            const { state } = permission.data;

            if (state !== 'active') {
                return result;
            }

            result[role] = true;

            return result;
        } catch (err) {
            logger.error('Failed to getOrgPermissions: ', err);
            throw err;
        }
    }

    /**
     * Get a commit sha for a specific repo#branch or pull request
     * @async  _getCommitSha
     * @param  {Object}   config
     * @param  {String}   config.scmUri     The scmUri to get commit sha of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  [config.prNum]    The PR number used to fetch the PR
     * @param  {Object}   [config.scmRepo]  The SCM repo metadata
     * @return {Promise}                    Resolves to the commit SHA
     */
    async _getCommitSha(config) {
        if (config.prNum) {
            const { pullRequestInfo } = await this.waitPrMergeability(config, 0);

            return pullRequestInfo.sha;
        }

        const lookupConfig = {
            scmUri: config.scmUri,
            token: config.token
        };

        if (config.scmRepo) {
            lookupConfig.scmRepo = config.scmRepo;
        }

        const scmInfo = await this.lookupScmUri(lookupConfig);

        try {
            const branch = await this.breaker.runCommand({
                action: 'getBranch',
                token: config.token,
                params: {
                    branch: scmInfo.branch.replace(/#/g, '%23'),
                    owner: scmInfo.owner,
                    repo: scmInfo.repo
                }
            });

            return branch.data.commit.sha;
        } catch (err) {
            logger.error('Failed to getCommitSha: ', err);
            throw err;
        }
    }

    /**
     * Get a commit sha from a reference
     * @async  _getCommitRefSha
     * @param  {Object}   config
     * @param  {String}   config.token     The token used to authenticate to the SCM
     * @param  {String}   config.owner     The owner of the target repository
     * @param  {String}   config.repo      The target repository name
     * @param  {String}   config.ref       The reference which we want
     * @param  {String}   config.refType   The reference type. ex. branch is 'heads', tag is 'tags'.
     * @return {Promise}                   Resolves to the commit sha
     */
    async _getCommitRefSha(config) {
        try {
            const refObj = await this.breaker.runCommand({
                action: 'getRef',
                token: config.token,
                scopeType: 'git',
                params: {
                    owner: config.owner,
                    repo: config.repo,
                    ref: `${config.refType}/${config.ref}`
                }
            });

            if (refObj.data.object.type === 'tag') {
                // annotated tag
                const tagObj = await this.breaker.runCommand({
                    action: 'getTag',
                    token: config.token,
                    scopeType: 'git',
                    params: {
                        owner: config.owner,
                        repo: config.repo,
                        tag_sha: refObj.data.object.sha
                    }
                });

                return tagObj.data.object.sha;
            }
            if (refObj.data.object.type === 'commit') {
                // commit or lightweight tag
                return refObj.data.object.sha;
            }

            return throwError(`Cannot handle ${refObj.data.object.type} type`);
        } catch (err) {
            logger.error('Failed to getCommitRefSha: ', err);
            throw err;
        }
    }

    /**
     * Update the commit status for a given repo and sha
     * @async  _updateCommitStatus
     * @param  {Object}   config
     * @param  {String}   config.scmUri       The scmUri to get permissions on
     * @param  {String}   config.sha          The sha to apply the status to
     * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   config.jobName      Optional name of the job that finished
     * @param  {String}   config.url          Target url
     * @param  {Number}   config.pipelineId   Pipeline Id
     * @param  {String}   config.context      Status context
     * @param  {String}   config.description  Status description
     * @return {Promise}                      Resolves when operation completed
     */
    async _updateCommitStatus({ scmUri, sha, buildStatus, token, jobName, url, pipelineId, context, description }) {
        const { owner, repo } = await this.lookupScmUri({
            scmUri,
            token
        });
        const statusTitle = context
            ? `Screwdriver/${pipelineId}/${context}`
            : `Screwdriver/${pipelineId}/${jobName.replace(/^PR-\d+/g, 'PR')}`; // (e.g. Screwdriver/12/PR:main)
        const params = {
            context: statusTitle,
            description: description || DESCRIPTION_MAP[buildStatus],
            repo,
            sha,
            state: STATE_MAP[buildStatus] || 'failure',
            owner,
            target_url: url
        };

        try {
            const status = await this.breaker.runCommand({
                action: 'createCommitStatus',
                token,
                params
            });

            return status ? status.data : undefined;
        } catch (err) {
            if (err.statusCode !== 422) {
                logger.error('Failed to updateCommitStatus: ', err);
                throw err;
            }

            return undefined;
        }
    }

    /**
     * Fetch content of a file from github
     * @async  _getFile
     * @param  {Object}   config
     * @param  {String}   config.scmUri       The scmUri to get permissions on
     * @param  {String}   config.path         The file in the repo to fetch
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   [config.ref]        The reference to the SCM, either branch or sha
     * @param  {Object}   [config.scmRepo]    The SCM repository to look up
     * @return {Promise}                      Resolves to string containing contents of file
     */
    async _getFile({ scmUri, path, token, ref, scmRepo }) {
        let fullPath = path;
        let owner;
        let repo;
        let branch;
        let rootDir;

        // If full path to a file is provided, e.g. git@github.com:screwdriver-cd/scm-github.git:path/to/a/file.yaml
        if (CHECKOUT_URL_REGEX.test(path)) {
            ({ owner, repo, branch, rootDir } = getInfo(fullPath));
            fullPath = rootDir;
        } else {
            const lookupConfig = {
                scmUri,
                token
            };

            if (scmRepo) {
                lookupConfig.scmRepo = scmRepo;
            }

            ({ owner, repo, branch, rootDir } = await this.lookupScmUri(lookupConfig));
            fullPath = rootDir ? Path.join(rootDir, path) : path;
        }

        try {
            const file = await this.breaker.runCommand({
                action: 'getContent',
                token,
                params: {
                    owner,
                    repo,
                    path: fullPath,
                    ref: ref || branch || DEFAULT_BRANCH
                }
            });

            if (file.data.type !== 'file') {
                throwError(`Path (${fullPath}) does not point to file`);
            }

            return Buffer.from(file.data.content, file.data.encoding).toString();
        } catch (err) {
            logger.error('Failed to getFile: ', err);

            if (err.statusCode === 404) {
                // Returns an empty file if there is no screwdriver.yaml
                return '';
            }

            throw err;
        }
    }

    /**
     * Retrieve stats for the executor
     * @method stats
     * @param  {Response} Object          Object containing stats for the executor
     */
    stats() {
        const stats = this.breaker.stats();
        const scmContexts = this._getScmContexts();
        const scmContext = scmContexts[0];

        return {
            [scmContext]: stats
        };
    }

    /**
     * Get repo id and default branch of specific repo
     * @async  _getRepoInfo
     * @param  {Object}   scmInfo               The result of getScmInfo
     * @param  {String}   token                 The token used to authenticate to the SCM
     * @param  {String}   checkoutUrl           The checkoutUrl to parse
     * @return {Promise}                        Resolves an object with repo id and default branch
     */
    async _getRepoInfo(scmInfo, token, checkoutUrl) {
        try {
            const repo = await this.breaker.runCommand({
                action: 'get',
                token,
                params: scmInfo
            });

            return { repoId: repo.data.id, defaultBranch: repo.data.default_branch };
        } catch (err) {
            if (err.statusCode === 404) {
                throwError(`Cannot find repository ${checkoutUrl}`, 404);
            }

            logger.error('Failed to getRepoId: ', err);
            throw err;
        }
    }

    /**
     * Decorate the author based on the Github service
     * @async  _decorateAuthor
     * @param  {Object}        config
     * @param  {Object}        config.token    Service token to authenticate with Github
     * @param  {Object}        config.username Username to query more information for
     * @return {Promise}                       Resolves to decorated user object
     */
    async _decorateAuthor(config) {
        try {
            const user = await this.breaker.runCommand({
                action: 'getByUsername',
                scopeType: 'users',
                token: config.token,
                params: { username: config.username }
            });
            const name = user.data.name || user.data.login;

            return {
                avatar: user.data.avatar_url,
                name,
                username: user.data.login,
                url: user.data.html_url
            };
        } catch (err) {
            logger.error('Failed to decorateAuthor: ', err);
            throw err;
        }
    }

    /**
     * Decorate the commit based on the repository
     * @async  _decorateCommit
     * @param  {Object}        config
     * @param  {Object}        config.scmUri SCM URI the commit belongs to
     * @param  {Object}        config.sha    SHA to decorate data with
     * @param  {Object}        config.token  Service token to authenticate with Github
     * @return {Promise}                     Resolves to decorated commit object
     */
    async _decorateCommit(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });

        try {
            const commit = await this.breaker.runCommand({
                action: 'getCommit',
                token: config.token,
                params: {
                    owner: scmInfo.owner,
                    repo: scmInfo.repo,
                    ref: config.sha
                }
            });

            const authorLogin = hoek.reach(commit, 'data.author.login');
            const authorName = hoek.reach(commit, 'data.commit.author.name');
            const committerLogin = hoek.reach(commit, 'data.committer.login');
            const committerName = hoek.reach(commit, 'data.commit.committer.name');
            let author = { ...DEFAULT_AUTHOR };
            let committer = { ...DEFAULT_AUTHOR };

            if (authorLogin) {
                author = await this.decorateAuthor({
                    token: config.token,
                    username: authorLogin
                });
            } else if (authorName) {
                author.name = authorName;
            }

            if (committerLogin) {
                if (committerLogin === authorLogin) {
                    committer = author;
                } else {
                    committer = await this.decorateAuthor({
                        token: config.token,
                        username: committerLogin
                    });
                }
            } else if (committerName) {
                committer.name = committerName;
            }

            return {
                author,
                committer,
                message: commit.data.commit.message,
                url: commit.data.html_url
            };
        } catch (err) {
            logger.error('Failed to decorateCommit: ', err);
            throw err;
        }
    }

    /**
     * Decorate a given SCM URI with additional data to better display
     * related information. If a branch suffix is not provided, it will default
     * to the default branch
     * @async  _decorateUrl
     * @param  {Config}    config
     * @param  {String}    config.scmUri        The SCM URI the commit belongs to
     * @param  {Object}    [config.scmRepo]     The SCM repository to look up
     * @param  {String}    config.token         Service token to authenticate with Github
     * @return {Promise}                        Resolves to decorated url object
     */
    async _decorateUrl({ scmUri, scmRepo, token }) {
        const lookupConfig = {
            scmUri,
            token
        };

        if (scmRepo) {
            lookupConfig.scmRepo = scmRepo;
        }

        const { host, owner, repo, branch, rootDir, privateRepo } = await this.lookupScmUri(lookupConfig);

        const baseUrl = `${host}/${owner}/${repo}/tree/${branch}`;

        return {
            branch,
            name: `${owner}/${repo}`,
            url: `https://${rootDir ? Path.join(baseUrl, rootDir) : baseUrl}`,
            rootDir: rootDir || '',
            private: privateRepo
        };
    }

    /**
     * Get the changed files from a Github event
     * @async  _getChangedFiles
     * @param  {Object}   config
     * @param  {String}   config.type               Can be 'pr' or 'repo'
     * @param  {Object}   [config.webhookConfig]    The webhook payload received from the SCM service.
     * @param  {String}   config.token              Service token to authenticate with Github
     * @param  {String}   [config.scmUri]           The scmUri to get PR info of
     * @param  {Integer}  [config.prNum]            The PR number
     * @return {Promise}                            Resolves to an array of filenames of the changed files
     */
    async _getChangedFiles({ type, webhookConfig, token, scmUri, prNum }) {
        if (type === 'pr') {
            try {
                await this.waitPrMergeability({ scmUri, token, prNum }, 0);

                const scmInfo = await this.lookupScmUri({ scmUri, token });
                const files = await this.breaker.runCommand({
                    scopeType: 'paginate',
                    route: 'GET /repos/:owner/:repo/pulls/:pull_number/files',
                    token,
                    params: {
                        owner: scmInfo.owner,
                        repo: scmInfo.repo,
                        pull_number: prNum,
                        per_page: PR_FILES_PAGE_SIZE
                    }
                });

                return files.map(file => file.filename);
            } catch (err) {
                logger.error('Failed to getChangedFiles: ', err);

                return [];
            }
        }

        if (type === 'repo') {
            const options = { default: [] };
            const added = hoek.reach(webhookConfig, 'addedFiles', options);
            const modified = hoek.reach(webhookConfig, 'modifiedFiles', options);
            const removed = hoek.reach(webhookConfig, 'removedFiles', options);

            // Adding the arrays together and pruning duplicates
            return [...new Set([...added, ...modified, ...removed])];
        }

        return [];
    }

    /**
     * Given a SCM webhook payload & its associated headers, aggregate the
     * necessary data to execute a Screwdriver job with.
     * @async  _parseHook
     * @param  {Object}  payloadHeaders  The request headers associated with the
     *                                   webhook payload
     * @param  {Object}  webhookPayload  The webhook payload received from the
     *                                   SCM service.
     * @return {Promise}                 A key-map of data related to the received
     *                                   payload
     */
    async _parseHook(payloadHeaders, webhookPayload) {
        const signature = payloadHeaders['x-hub-signature'];

        const type = payloadHeaders['x-github-event'];
        const hookId = payloadHeaders['x-github-delivery'];
        const checkoutUrl = hoek.reach(webhookPayload, 'repository.ssh_url');
        const scmContexts = this._getScmContexts();
        const commitAuthors = [];
        const commits = hoek.reach(webhookPayload, 'commits');
        const deleted = hoek.reach(webhookPayload, 'deleted');

        const checkoutSshHost = this.config.gheHost ? this.config.gheHost : 'github.com';
        const regexMatchArray = checkoutUrl.match(CHECKOUT_URL_REGEX);

        if (!regexMatchArray || regexMatchArray[1] !== checkoutSshHost) {
            logger.info(`Incorrect checkout SshHost: ${checkoutUrl}`);

            return null;
        }

        // eslint-disable-next-line no-underscore-dangle
        if (!verify(this.config.secret, webhookPayload, signature)) {
            throwError('Invalid x-hub-signature');
        }

        switch (type) {
            case 'pull_request': {
                let action = hoek.reach(webhookPayload, 'action');
                const prNum = hoek.reach(webhookPayload, 'pull_request.number');
                const prTitle = hoek.reach(webhookPayload, 'pull_request.title');
                const baseSource = hoek.reach(webhookPayload, 'pull_request.base.repo.id');
                const headSource = hoek.reach(webhookPayload, 'pull_request.head.repo.id');
                const prSource = baseSource === headSource ? 'branch' : 'fork';
                const ref = `pull/${prNum}/merge`;

                // Possible actions
                // "opened", "closed", "reopened", "synchronize",
                // "assigned", "unassigned", "labeled", "unlabeled", "edited"
                if (!['opened', 'reopened', 'synchronize', 'closed'].includes(action)) {
                    return null;
                }

                if (action === 'synchronize') {
                    action = 'synchronized';
                }

                return {
                    action,
                    branch: hoek.reach(webhookPayload, 'pull_request.base.ref'),
                    checkoutUrl,
                    prNum,
                    prTitle,
                    prRef: ref,
                    ref,
                    prSource,
                    sha: hoek.reach(webhookPayload, 'pull_request.head.sha'),
                    type: 'pr',
                    username: hoek.reach(webhookPayload, 'sender.login'),
                    hookId,
                    scmContext: scmContexts[0]
                };
            }
            case 'push': {
                const ref = hoek.reach(webhookPayload, 'ref');

                // repository tag pushed
                if (ref.startsWith('refs/tags/')) {
                    return null;
                }

                if (Array.isArray(commits)) {
                    commits.forEach(commit => {
                        commitAuthors.push(commit.author.name);
                    });
                }

                if (deleted) {
                    return null;
                }

                return {
                    action: 'push',
                    branch: hoek.reach(webhookPayload, 'ref').replace(/^refs\/heads\//, ''),
                    checkoutUrl,
                    sha: hoek.reach(webhookPayload, 'after'),
                    type: 'repo',
                    username: hoek.reach(webhookPayload, 'sender.login'),
                    commitAuthors,
                    lastCommitMessage: hoek.reach(webhookPayload, 'head_commit.message') || '',
                    hookId,
                    scmContext: scmContexts[0],
                    ref: hoek.reach(webhookPayload, 'ref'),
                    addedFiles: hoek.reach(webhookPayload, 'head_commit.added', { default: [] }),
                    modifiedFiles: hoek.reach(webhookPayload, 'head_commit.modified', { default: [] }),
                    removedFiles: hoek.reach(webhookPayload, 'head_commit.removed', { default: [] })
                };
            }
            case 'release': {
                const action = hoek.reach(webhookPayload, 'action');

                if (!PERMITTED_RELEASE_EVENT.includes(action)) {
                    return null;
                }

                return {
                    action: 'release',
                    branch: hoek.reach(webhookPayload, 'repository.default_branch'),
                    checkoutUrl,
                    type: 'repo',
                    username: hoek.reach(webhookPayload, 'sender.login'),
                    hookId,
                    scmContext: scmContexts[0],
                    ref: hoek.reach(webhookPayload, 'release.tag_name'),
                    releaseId: hoek.reach(webhookPayload, 'release.id').toString(),
                    releaseName: hoek.reach(webhookPayload, 'release.name') || '',
                    releaseAuthor: hoek.reach(webhookPayload, 'release.author.login') || ''
                };
            }
            case 'create': {
                const refType = hoek.reach(webhookPayload, 'ref_type');

                if (refType !== 'tag') {
                    logger.info('%s event of %s is not available yet in scm-github plugin', type, refType);

                    return null;
                }

                return {
                    action: 'tag',
                    branch: hoek.reach(webhookPayload, 'repository.default_branch'),
                    checkoutUrl,
                    type: 'repo',
                    username: hoek.reach(webhookPayload, 'sender.login'),
                    hookId,
                    scmContext: scmContexts[0],
                    ref: hoek.reach(webhookPayload, 'ref')
                };
            }

            default:
                logger.info('%s event is not available yet in scm-github plugin', type);

                return null;
        }
    }

    /**
     * Parses a SCM URL into a Screwdriver-representable ID
     *
     * 'token' is required, since it is necessary to lookup the SCM ID by
     * communicating with said SCM service.
     * @async  _parseUrl
     * @param  {Object}     config
     * @param  {String}     config.checkoutUrl  The checkoutUrl to parse
     * @param  {String}     [config.rootDir]    The root directory
     * @param  {String}     config.token        The token used to authenticate to the SCM service
     * @return {Promise}                        Resolves to an ID of 'serviceName:repoId:branchName:rootDir'
     */
    async _parseUrl({ checkoutUrl, rootDir, token }) {
        const scmInfo = getInfo(checkoutUrl, rootDir);
        const { host, branch, rootDir: sourceDir } = scmInfo;
        const myHost = this.config.gheHost || 'github.com';

        if (host !== myHost) {
            throwError('This checkoutUrl is not supported for your current login host.', 400);
        }

        const { repoId, defaultBranch } = await this._getRepoInfo(scmInfo, token, checkoutUrl);
        const scmUri = `${host}:${repoId}:${branch || defaultBranch}`;

        return sourceDir ? `${scmUri}:${sourceDir}` : scmUri;
    }

    /**
     * Return a valid Bell configuration (for OAuth)
     * @async  _getBellConfiguration
     * @return {Promise}
     */
    async _getBellConfiguration() {
        const scmContexts = this._getScmContexts();
        const scmContext = scmContexts[0];
        const scope = ['admin:repo_hook', 'read:org', 'repo:status'];
        const cookie = this.config.gheHost ? `github-${this.config.gheHost}` : 'github-github.com';
        const bellConfig = {
            provider: 'github',
            cookie,
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

        return { [scmContext]: bellConfig };
    }

    /**
     * Resolve a pull request object based on the config
     * @async  _getPrInfo
     * @param  {Object}   config
     * @param  {Object}   [config.scmRepo]  The SCM repository to look up
     * @param  {String}   config.scmUri     The scmUri to get PR info of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  config.prNum      The PR number used to fetch the PR
     * @return {Promise}
     */
    async _getPrInfo(config) {
        const lookupConfig = {
            scmUri: config.scmUri,
            token: config.token
        };

        if (config.scmRepo) {
            lookupConfig.scmRepo = config.scmRepo;
        }

        const scmInfo = await this.lookupScmUri(lookupConfig);

        try {
            const pullRequestInfo = await this.breaker.runCommand({
                action: 'get',
                scopeType: 'pulls',
                token: config.token,
                params: {
                    pull_number: config.prNum,
                    owner: scmInfo.owner,
                    repo: scmInfo.repo
                }
            });
            const prSource =
                pullRequestInfo.data.head.repo.id === pullRequestInfo.data.base.repo.id ? 'branch' : 'fork';

            return {
                name: `PR-${pullRequestInfo.data.number}`,
                ref: `pull/${pullRequestInfo.data.number}/merge`,
                sha: pullRequestInfo.data.head.sha,
                prBranchName: pullRequestInfo.data.head.ref,
                url: pullRequestInfo.data.html_url,
                username: pullRequestInfo.data.user.login,
                title: pullRequestInfo.data.title,
                createTime: pullRequestInfo.data.created_at,
                userProfile: pullRequestInfo.data.user.html_url,
                baseBranch: pullRequestInfo.data.base.ref,
                mergeable: pullRequestInfo.data.mergeable,
                prSource
            };
        } catch (err) {
            logger.error('Failed to getPrInfo: ', err);
            throw err;
        }
    }

    /**
     * Add a PR comment
     * @async  _addPrComment
     * @param  {Object}     config
     * @param  {String}     config.comment     The PR comment
     * @param  {Integer}    config.prNum       The PR number
     * @param  {String}     config.scmUri      The SCM URI
     * @param  {String}     config.token       Service token to authenticate with Github
     * @return {Promise}                       Resolves when complete
     */
    async _addPrComment({ comment, jobName, prNum, scmUri, token, pipelineId }) {
        const scmInfo = await this.lookupScmUri({
            scmUri,
            token
        });

        const prComments = await this.prComments(scmInfo, prNum, token);

        if (prComments) {
            const botComment = prComments.comments.find(
                commentObj =>
                    commentObj.user.login === this.config.username &&
                    commentObj.body.split(/\n/)[0].match(PR_COMMENTS_REGEX) &&
                    commentObj.body.split(/\n/)[0].match(PR_COMMENTS_REGEX)[1] === pipelineId.toString() &&
                    commentObj.body.split(/\n/)[0].match(PR_COMMENTS_REGEX)[2] === jobName
            );

            if (botComment) {
                try {
                    const pullRequestComment = await this.editPrComment(botComment.id, scmInfo, comment);

                    return {
                        commentId: `${pullRequestComment.data.id}`,
                        createTime: `${pullRequestComment.data.created_at}`,
                        username: pullRequestComment.data.user.login
                    };
                } catch (err) {
                    logger.error('Failed to addPRComment: ', err);

                    return null;
                }
            }
        }

        try {
            const pullRequestComment = await this.breaker.runCommand({
                action: 'createComment',
                scopeType: 'issues',
                token: this.config.commentUserToken, // need to use a token with public_repo permissions
                params: {
                    body: comment,
                    issue_number: prNum,
                    owner: scmInfo.owner,
                    repo: scmInfo.repo
                }
            });

            return {
                commentId: `${pullRequestComment.data.id}`,
                createTime: `${pullRequestComment.data.created_at}`,
                username: pullRequestComment.data.user.login
            };
        } catch (err) {
            logger.error('Failed to addPRComment: ', err);

            return null;
        }
    }

    /**
     * Get an array of scm context (e.g. github:github.com)
     * @method _getScmContexts
     * @return {Array}          Array of scm contexts
     */
    _getScmContexts() {
        const contextName = this.config.gheHost ? [`github:${this.config.gheHost}`] : ['github:github.com'];

        return contextName;
    }

    /**
     * Determine if an scm module can handle the received webhook
     * @async  _canHandleWebhook
     * @param  {Object}    headers    The request headers associated with the webhook payload
     * @param  {Object}    payload    The webhook payload received from the SCM service
     * @return {Promise}              Resolves a boolean denoting whether scm module supports webhook
     */
    async _canHandleWebhook(headers, payload) {
        try {
            const result = await this._parseHook(headers, payload);

            return result !== null;
        } catch (err) {
            logger.error('Failed to run canHandleWebhook', err);

            return false;
        }
    }

    /**
     * Look up a branches from a repo
     * @async  _findBranches
     * @param  {Object}     config
     * @param  {Object}     config.scmInfo      Data about repo
     * @param  {String}     config.token        Admin token for repo
     * @param  {Number}     config.page         Pagination: page number to search next
     * @return {Promise}                        Resolves to a list of branches
     */
    async _findBranches(config) {
        try {
            let branches = await this.breaker.runCommand({
                action: 'listBranches',
                token: config.token,
                params: {
                    owner: config.scmInfo.owner,
                    repo: config.scmInfo.repo,
                    page: config.page,
                    per_page: BRANCH_PAGE_SIZE
                }
            });

            branches = branches.data;

            if (branches.length === BRANCH_PAGE_SIZE) {
                config.page += 1;
                const nextPageBranches = await this._findBranches(config);

                branches = branches.concat(nextPageBranches);
            }

            return branches.map(branch => ({ name: hoek.reach(branch, 'name') }));
        } catch (err) {
            logger.error('Failed to findBranches: ', err);
            throw err;
        }
    }

    /**
     * Get branch list from the Github repository
     * @async  _getBranchList
     * @param  {Object}     config
     * @param  {String}     config.scmUri      The SCM URI to get branch list
     * @param  {String}     config.token       Service token to authenticate with Github
     * @return {Promise}                       Resolves when complete
     */
    async _getBranchList(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });

        return this._findBranches({
            scmInfo,
            page: 1,
            token: config.token
        }).catch(err => {
            logger.error('Failed to getBranchList: ', err);
            throw err;
        });
    }

    /**
     * Open a pull request on the repository with given file change
     *
     * @method _openPr
     * @param  {Object}     config                  Configuration
     * @param  {String}     config.checkoutUrl      Checkout url to the repo
     * @param  {String}     config.token            Service token to authenticate with the SCM service
     * @param  {String}     config.files            Files to open pull request with
     * @param  {String}     config.title            Pull request title
     * @param  {String}     config.message          Pull request message
     * @param  {String}     [config.scmContext]     The scm context name
     * @return {Promise}                            Resolves when operation completed without failure
     */
    async _openPr(config) {
        const { checkoutUrl, token, files, title, message } = config;
        const [, , owner, repo, branch] = checkoutUrl.match(CHECKOUT_URL_REGEX);
        const newBranch = title.replace(/ /g, '_');

        return this.breaker
            .runCommand({
                action: 'getBranch',
                scopeType: 'repos',
                token,
                params: {
                    owner,
                    repo,
                    branch: branch.slice(1)
                }
            })
            .then(baseBranch =>
                this.breaker.runCommand({
                    action: 'createRef',
                    scopeType: 'git',
                    token,
                    params: {
                        owner,
                        repo,
                        ref: `refs/heads/${newBranch}`,
                        sha: baseBranch.data.commit.sha
                    }
                })
            )
            .then(() =>
                Promise.all(
                    files.map(file =>
                        this.breaker.runCommand({
                            action: 'createOrUpdateFileContents',
                            scopeType: 'repos',
                            token,
                            params: {
                                owner,
                                repo,
                                path: file.name,
                                branch: newBranch,
                                message,
                                content: Buffer.from(file.content).toString('base64')
                            }
                        })
                    )
                )
            )
            .then(() =>
                this.breaker.runCommand({
                    action: 'create',
                    scopeType: 'pulls',
                    token,
                    params: {
                        owner,
                        repo,
                        title,
                        head: `${owner}:${newBranch}`,
                        base: branch.slice(1)
                    }
                })
            )
            .catch(err => {
                logger.error('Failed to openPr: ', err);
                throw err;
            });
    }
}

module.exports = GithubScm;
