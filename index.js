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
     * @param  {Object}  config                      Configuration object
     * @param  {Boolean} [config.privateRepo=false]  Request 'repo' scope, which allows read/write access for public & private repos
     * @param  {String}  [config.gheHost=null]       If using GitHub Enterprise, the host/port of the deployed instance
     * @param  {String}  [config.gheProtocol=https]  If using GitHub Enterprise, the protocol to use
     * @param  {String}  [config.username=sd-buildbot]           GitHub username for checkout
     * @param  {String}  [config.email=dev-null@screwdriver.cd]  GitHub user email for checkout
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
            // Do not retry when there is a 4XX error
            shouldRetry: err => err && !(err.code >= 400 && err.code < 500),
            retry: this.config.fusebox.retry,
            breaker: this.config.fusebox.breaker
        });
    }

    /**
     * Look up a repo by SCM URI
     * @async  lookupScmUri
     * @param  {Object}     config
     * @param  {Object}     config.scmUri  The SCM URI to look up relevant info
     * @param  {Object}     config.token   Service token to authenticate with Github
     * @return {Promise}                   Resolves to an object containing repository-related information
     */
    async lookupScmUri(config) {
        const [scmHost, scmId, scmBranch] = config.scmUri.split(':');

        const repo = await this.breaker.runCommand({
            action: 'getById',
            token: config.token,
            params: { id: scmId }
        });

        const [repoOwner, repoName] = repo.full_name.split('/');

        return {
            branch: scmBranch,
            host: scmHost,
            repo: repoName,
            owner: repoOwner
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
        const hooks = await this.breaker.runCommand({
            action: 'getHooks',
            token: config.token,
            params: {
                owner: config.scmInfo.owner,
                repo: config.scmInfo.repo,
                page: config.page,
                per_page: WEBHOOK_PAGE_SIZE
            }
        });

        const screwdriverHook = hooks.find(hook =>
            hoek.reach(hook, 'config.url') === config.url
        );

        if (!screwdriverHook && hooks.length === WEBHOOK_PAGE_SIZE) {
            config.page += 1;

            return this._findWebhook(config);
        }

        return screwdriverHook;
    }

    /**
     * Create or edit a webhook (edits if hookInfo exists)
     * @method _createWebhook
     * @param  {Object}     config
     * @param  {Object}     [config.hookInfo]   Information about a existing webhook
     * @param  {Object}     config.scmInfo      Information about the repo
     * @param  {String}     config.token        Admin token for repo
     * @param  {String}     config.url          Payload destination url for webhook notifications
     * @return {Promise}                        Resolves when complete
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
     * @async  _addWebhook
     * @param  {Object}    config             Config object
     * @param  {String}    config.scmUri      The SCM URI to add the webhook to
     * @param  {String}    config.token       Service token to authenticate with Github
     * @param  {String}    config.webhookUrl  The URL to use for the webhook notifications
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
            token: config.token,
            url: config.webhookUrl
        });
    }

    /**
     * Get the command to check out source code from a repository
     * @async  getCheckoutCommand
     * @param  {Object}    config
     * @param  {String}    config.branch        Pipeline branch
     * @param  {String}    config.host          Scm host to checkout source code from
     * @param  {String}    config.org           Scm org name
     * @param  {String}    config.repo          Scm repo name
     * @param  {String}    config.sha           Commit sha
     * @param  {String}    [config.prRef]       PR reference (can be a PR branch or reference)
     * @param  {String}    [config.scmContext]  The scm context name
     * @param  {String}    [config.manifest]    Repo manifest URL (only defined if `screwdriver.cd/repoManifest` annotation is)
     * @return {Promise}                        Resolves to object containing name and checkout commands
     */
    async _getCheckoutCommand(config) {
        const checkoutUrl = `${config.host}/${config.org}/${config.repo}`; // URL for https
        const sshCheckoutUrl = `git@${config.host}:${config.org}/${config.repo}`; // URL for ssh
        const checkoutRef = config.prRef ? config.branch : config.sha; // if PR, use pipeline branch
        const gitWrapper = '$(if git --version > /dev/null 2>&1; ' +
            "then echo 'eval'; " +
            "else echo 'sd-step exec core/git'; fi)";
        const command = [];

        // Export environment variables
        command.push('echo Exporting environment variables');
        command.push('if [ ! -z $SCM_CLONE_TYPE ] && [ $SCM_CLONE_TYPE = ssh ]; ' +
            `then export SCM_URL=${sshCheckoutUrl}; ` +
            'elif [ ! -z $SCM_USERNAME ] && [ ! -z $SCM_ACCESS_TOKEN ]; ' +
            `then export SCM_URL=https://$SCM_USERNAME:$SCM_ACCESS_TOKEN@${checkoutUrl}; ` +
            `else export SCM_URL=https://${checkoutUrl}; fi`);
        command.push('export GIT_URL=$SCM_URL.git');
        // git 1.7.1 doesn't support --no-edit with merge, this should do same thing
        command.push('export GIT_MERGE_AUTOEDIT=no');

        // Set config
        command.push('echo Setting user name and user email');
        command.push(`${gitWrapper} "git config --global user.name ${this.config.username}"`);
        command.push(`${gitWrapper} "git config --global user.email ${this.config.email}"`);

        if (config.manifest) {
            const curlWrapper = '$(if curl --version > /dev/null 2>&1; ' +
                "then echo 'eval'; " +
                "else echo 'sd-step exec core/curl'; fi)";
            const wgetWrapper = '$(if wget --version > /dev/null 2>&1; ' +
                "then echo 'eval'; " +
                "else echo 'sd-step exec core/wget'; fi)";
            const grepWrapper = '$(if grep --version > /dev/null 2>&1; ' +
                "then echo 'eval'; " +
                "else echo 'sd-step exec core/grep'; fi)";

            const repoDownloadUrl = 'https://storage.googleapis.com/git-repo-downloads/repo';
            const sdRepoReleasesUrl = 'https://github.com/screwdriver-cd/sd-repo/releases/latest';

            command.push('echo Checking out code using the repo manifest defined in '
                + `${config.manifest}`);

            // Get the repo binary
            command.push(`${curlWrapper} "curl -s ${repoDownloadUrl} > /usr/local/bin/repo"`);
            command.push('chmod a+x /usr/local/bin/repo');

            // // Get the sd-repo binary and execute it
            command.push(`${wgetWrapper} "wget -q -O - ${sdRepoReleasesUrl}" | `
                + `${grepWrapper} "grep -E -o `
                + '/screwdriver-cd/sd-repo/releases/download/v[0-9.]*/sd-repo_linux_amd64" '
                + `| ${wgetWrapper} "wget --base=http://github.com/ -q -i - -O `
                + '/usr/local/bin/sd-repo"');
            command.push('chmod a+x /usr/local/bin/sd-repo');
            command.push(`sd-repo -manifestUrl=${config.manifest} `
                + `-sourceRepo=${config.org}/${config.repo}`);

            // sourcePath is the file created by `sd-repo` which contains the relative path to the source repository
            const sourcePath = 'sourcePath';

            // Export $SD_SOURCE_DIR to source repo path and cd into it
            command.push(`if [ $(cat ${sourcePath}) != "." ]; `
                + `then export SD_SOURCE_DIR=$SD_SOURCE_DIR/$(cat ${sourcePath}); fi`);
            command.push('cd $SD_SOURCE_DIR');
        } else {
            // Git clone
            command.push(`echo Cloning ${checkoutUrl}, on branch ${config.branch}`);
            command.push(`${gitWrapper} `
                    + `"git clone --recursive --quiet --progress --branch ${config.branch} `
                    + '$SCM_URL $SD_SOURCE_DIR"');
            // Reset to SHA
            command.push(`${gitWrapper} "git reset --hard ${checkoutRef} --"`);
            command.push(`echo Reset to ${checkoutRef}`);
        }

        // For pull requests
        if (config.prRef) {
            const prRef = config.prRef.replace('merge', 'head:pr');

            // Fetch a pull request
            command.push(`echo Fetching PR and merging with ${config.branch}`);
            command.push(`${gitWrapper} "git fetch origin ${prRef}"`);
            // Merge a pull request with pipeline branch
            command.push(`${gitWrapper} "git merge ${config.sha}"`);
            // Update submodule
            command.push(`${gitWrapper} "git submodule update --recursive"`);
            command.push(`export GIT_BRANCH=origin/refs/${prRef}`);
        } else {
            command.push(`export GIT_BRANCH=origin/${config.branch}`);
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
    async _getOpenedPRs(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const pullRequests = await this.breaker.runCommand({
            action: 'getAll',
            scopeType: 'pullRequests',
            token: config.token,
            params: {
                owner: scmInfo.owner,
                repo: scmInfo.repo,
                state: 'open'
            }
        });

        return pullRequests.map(pullRequest => ({
            name: `PR-${pullRequest.number}`,
            ref: `pull/${pullRequest.number}/merge`
        }));
    }

    /**
     * Get a owners permissions on a repository
     * @async  _getPermissions
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get permissions on
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @return {Promise}                    Resolves to the repository permissions
     */
    async _getPermissions(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const repo = await this.breaker.runCommand({
            action: 'get',
            token: config.token,
            params: {
                repo: scmInfo.repo,
                owner: scmInfo.owner
            }
        });

        return repo.permissions;
    }

    /**
     * Get a commit sha for a specific repo#branch or pull request
     * @async  getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get commit sha of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  [config.prNum]    The PR number used to fetch the PR
     * @return {Promise}                    Resolves to the commit SHA
     */
    async _getCommitSha(config) {
        if (config.prNum) {
            return this._getPrInfo(config).then(pr => pr.sha);
        }

        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const branch = await this.breaker.runCommand({
            action: 'getBranch',
            token: config.token,
            params: {
                branch: scmInfo.branch,
                host: scmInfo.host,
                repo: scmInfo.repo,
                owner: scmInfo.owner
            }
        });

        return branch.commit.sha;
    }

    /**
     * Update the commit status for a given repo and sha
     * @async  updateCommitStatus
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri to get permissions on
     * @param  {String}   config.sha          The sha to apply the status to
     * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   config.jobName      Optional name of the job that finished
     * @param  {String}   config.url          Target url
     * @param  {Number}   config.pipelineId   Pipeline Id
     * @return {Promise}                      Resolves when operation completed
     */
    async _updateCommitStatus(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const jobName = config.jobName.replace(/^PR-\d+/g, 'PR');
        const params = {
            context: `Screwdriver/${config.pipelineId}/${jobName}`,
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
        }).catch((err) => {
            if (err.code !== 422) {
                throw err;
            }
        });
    }

    /**
     * Fetch content of a file from github
     * @async  getFile
     * @param  {Object}   config              Configuration
     * @param  {String}   config.scmUri       The scmUri to get permissions on
     * @param  {String}   config.path         The file in the repo to fetch
     * @param  {String}   config.token        The token used to authenticate to the SCM
     * @param  {String}   config.ref          The reference to the SCM, either branch or sha
     * @return {Promise}                      Resolves to string containing contents of file
     */
    async _getFile(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const file = await this.breaker.runCommand({
            action: 'getContent',
            token: config.token,
            params: {
                owner: scmInfo.owner,
                repo: scmInfo.repo,
                path: config.path,
                ref: config.ref || scmInfo.branch
            }
        });

        if (file.type !== 'file') {
            throw new Error(`Path (${config.path}) does not point to file`);
        }

        return new Buffer(file.content, file.encoding).toString();
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
     * Get id of a specific repo
     * @async  _getRepoId
     * @param  {Object}   scmInfo               The result of getScmInfo
     * @param  {String}   token                 The token used to authenticate to the SCM
     * @param  {String}   config.checkoutUrl    The checkoutUrl to parse
     * @return {Promise}                        Resolves to the id of the repo
     */
    async _getRepoId(scmInfo, token, checkoutUrl) {
        try {
            const repo = await this.breaker.runCommand({
                action: 'get',
                token,
                params: scmInfo
            });

            return repo.id;
        } catch (err) {
            if (err.code === 404) {
                throw new Error(`Cannot find repository ${checkoutUrl}`);
            }

            throw new Error(err);
        }
    }

    /**
     * Decorate the author based on the Github service
     * @async  _decorateAuthor
     * @param  {Object}        config          Configuration object
     * @param  {Object}        config.token    Service token to authenticate with Github
     * @param  {Object}        config.username Username to query more information for
     * @return {Promise}                       Resolves to decorated user object
     */
    async _decorateAuthor(config) {
        const user = await this.breaker.runCommand({
            action: 'getForUser',
            scopeType: 'users',
            token: config.token,
            params: { username: config.username }
        });
        const name = user.name ? user.name : user.login;

        return {
            avatar: user.avatar_url,
            name,
            username: user.login,
            url: user.html_url
        };
    }

    /**
     * Decorate the commit based on the repository
     * @async  _decorateCommit
     * @param  {Object}        config        Configuration object
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
        const commit = await this.breaker.runCommand({
            action: 'getCommit',
            token: config.token,
            params: {
                owner: scmInfo.owner,
                repo: scmInfo.repo,
                sha: config.sha
            }
        });

        let author;

        if (!commit.author) {
            author = DEFAULT_AUTHOR;
        } else {
            author = await this.decorateAuthor({
                token: config.token,
                username: commit.author.login
            });
        }

        return {
            author,
            message: commit.commit.message,
            url: commit.html_url
        };
    }

    /**
     * Decorate a given SCM URI with additional data to better display
     * related information. If a branch suffix is not provided, it will default
     * to the master branch
     * @async  _decorateUrl
     * @param  {Config}    config        Configuration object
     * @param  {String}    config.scmUri The SCM URI the commit belongs to
     * @param  {String}    config.token  Service token to authenticate with Github
     * @return {Promise}                 Resolves to decorated url object
     */
    async _decorateUrl(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const baseUrl = `${scmInfo.host}/${scmInfo.owner}/${scmInfo.repo}`;

        return {
            branch: scmInfo.branch,
            name: `${scmInfo.owner}/${scmInfo.repo}`,
            url: `https://${baseUrl}/tree/${scmInfo.branch}`
        };
    }

    /**
     * Check validity of github webhook event signature
     * @method  _checkSignature
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
     * Get the changed files from a Git event
     * @async  _getChangedFiles
     * @param  {Object}   config           Configuration object
     * @param  {String}   config.type      Can be 'pr' or 'repo'
     * @param  {Object}   config.payload   The webhook payload received from the SCM service.
     * @param  {String}   config.token     Service token to authenticate with Github
     * @return {Promise}                   Resolves to an array of filenames of the changed files
     */
    async _getChangedFiles({ type, payload, token }) {
        if (type === 'pr') {
            const files = await this.breaker.runCommand({
                action: 'getFiles',
                scopeType: 'pullRequests',
                token,
                params: {
                    owner: hoek.reach(payload, 'repository.owner.login'),
                    repo: hoek.reach(payload, 'repository.name'),
                    number: hoek.reach(payload, 'number')
                }
            });

            return files.map(file => file.filename);
        }

        if (type === 'repo') {
            const added = hoek.reach(payload, 'head_commit.added');
            const modified = hoek.reach(payload, 'head_commit.modified');
            const removed = hoek.reach(payload, 'head_commit.removed');

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

        // eslint-disable-next-line no-underscore-dangle
        if (!this._checkSignature(this.config.secret, webhookPayload, signature)) {
            throw new Error('Invalid x-hub-signature');
        }

        const type = payloadHeaders['x-github-event'];
        const hookId = payloadHeaders['x-github-delivery'];
        const checkoutUrl = hoek.reach(webhookPayload, 'repository.ssh_url');
        const scmContexts = this._getScmContexts();

        switch (type) {
        case 'pull_request': {
            let action = hoek.reach(webhookPayload, 'action');
            const prNum = hoek.reach(webhookPayload, 'pull_request.number');
            const baseSource = hoek.reach(webhookPayload, 'pull_request.base.repo.id');
            const headSource = hoek.reach(webhookPayload, 'pull_request.head.repo.id');
            const prSource = baseSource === headSource ? 'branch' : 'fork';

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
                prRef: `pull/${prNum}/merge`,
                prSource,
                sha: hoek.reach(webhookPayload, 'pull_request.head.sha'),
                type: 'pr',
                username: hoek.reach(webhookPayload, 'sender.login'),
                hookId,
                scmContext: scmContexts[0]
            };
        }
        case 'push':
            return {
                action: 'push',
                branch: hoek.reach(webhookPayload, 'ref').replace(/^refs\/heads\//, ''),
                checkoutUrl,
                sha: hoek.reach(webhookPayload, 'after'),
                type: 'repo',
                username: hoek.reach(webhookPayload, 'sender.login'),
                lastCommitMessage: hoek.reach(webhookPayload, 'head_commit.message') || '',
                hookId,
                scmContext: scmContexts[0]
            };
        default:
            return null;
        }
    }

    /**
     * Parses a SCM URL into a screwdriver-representable ID
     *
     * 'token' is required, since it is necessary to lookup the SCM ID by
     * communicating with said SCM service.
     * @async  _parseUrl
     * @param  {Object}     config              Config object
     * @param  {String}     config.checkoutUrl  The checkoutUrl to parse
     * @param  {String}     config.token        The token used to authenticate to the SCM service
     * @return {Promise}                        Resolves to an ID of 'serviceName:repoId:branchName'
     */
    async _parseUrl(config) {
        const scmInfo = getInfo(config.checkoutUrl);
        const myHost = this.config.gheHost || 'github.com';

        if (scmInfo.host !== myHost) {
            const message = 'This checkoutUrl is not supported for your current login host.';

            throw new Error(message);
        }

        const repoId = await this._getRepoId(scmInfo, config.token, config.checkoutUrl);

        return `${scmInfo.host}:${repoId}:${scmInfo.branch}`;
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
        const cookie = this.config.gheHost
            ? `github-${this.config.gheHost}`
            : 'github-github.com';
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
     * @async  getPrRef
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUri     The scmUri to get PR info of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @param  {Integer}  config.prNum      The PR number used to fetch the PR
     * @return {Promise}
     */
    async _getPrInfo(config) {
        const scmInfo = await this.lookupScmUri({
            scmUri: config.scmUri,
            token: config.token
        });
        const pullRequestInfo = await this.breaker.runCommand({
            action: 'get',
            scopeType: 'pullRequests',
            token: config.token,
            params: {
                owner: scmInfo.owner,
                repo: scmInfo.repo,
                number: config.prNum
            }
        });

        return {
            name: `PR-${pullRequestInfo.number}`,
            ref: `pull/${pullRequestInfo.number}/merge`,
            sha: pullRequestInfo.head.sha,
            url: pullRequestInfo.html_url
        };
    }

    /**
     * Get an array of scm context (e.g. github:github.com)
     * @method getScmContexts
     * @return {Array}
     */
    _getScmContexts() {
        const contextName = this.config.gheHost
            ? [`github:${this.config.gheHost}`]
            : ['github:github.com'];

        return contextName;
    }

    /**
     * Determine if a scm module can handle the received webhook
     * @async  canHandleWebhook
     * @param  {Object}    headers    The request headers associated with the webhook payload
     * @param  {Object}    payload    The webhook payload received from the SCM service
     * @return {Promise}              Resolves a boolean denoting whether scm module supports webhook
     */
    async _canHandleWebhook(headers, payload) {
        try {
            const result = await this._parseHook(headers, payload);
            const checkoutSshHost = this.config.gheHost
                ? `git@${this.config.gheHost}:`
                : 'git@github.com:';

            if (result === null) {
                return false;
            }

            return result.checkoutUrl.startsWith(checkoutSshHost);
        } catch (err) {
            return false;
        }
    }
}

module.exports = GithubScm;
