'use strict';
const Breaker = require('circuit-fuses');
const Github = require('github');
const schema = require('screwdriver-data-schema');
const Scm = require('screwdriver-scm-base');
const MATCH_COMPONENT_BRANCH_NAME = 4;
const MATCH_COMPONENT_REPO_NAME = 3;
const MATCH_COMPONENT_USER_NAME = 2;
const MATCH_COMPONENT_HOST_NAME = 1;
const STATE_MAP = {
    SUCCESS: 'success',
    RUNNING: 'pending',
    QUEUED: 'pending'
};

/**
* Get repo information
* @method getInfo
* @param  {String} scmUrl      scmUrl of the repo
* @return {Object}             An object with the user, repo, and branch
*/
function getInfo(scmUrl) {
    const matched = (schema.config.regex.SCM_URL).exec(scmUrl);

    // Check if regex did not pass
    if (!matched) {
        throw new Error(`Invalid scmUrl: ${scmUrl}`);
    }

    const branch = matched[MATCH_COMPONENT_BRANCH_NAME] || '#master';

    return {
        user: matched[MATCH_COMPONENT_USER_NAME],
        repo: matched[MATCH_COMPONENT_REPO_NAME],
        host: matched[MATCH_COMPONENT_HOST_NAME],
        branch: branch.slice(1)
    };
}

class GithubScm extends Scm {
    /**
    * Github command to run
    * @method _githubCommand
    * @param  {Object}   options            An object that tells what command & params to run
    * @param  {String}   options.action     Github method. For example: get
    * @param  {String}   options.token      Github token used for authentication of requests
    * @param  {Object}   options.params     Parameters to run with
    * @param  {Function} callback           Callback function from github API
    */
    _githubCommand(options, callback) {
        this.github.authenticate({
            type: 'oauth',
            token: options.token
        });

        this.github.repos[options.action](options.params, callback);
    }

    /**
    * Constructor
    * @method constructor
    * @param  {Object} options           Configuration options
    * @param  {Object} options.retry     Configuration options for circuit breaker retries
    * @param  {Object} options.breaker   Configuration options for circuit breaker
    * @return {GithubScm}
    */
    constructor(config) {
        super();

        this.config = config;
        this.github = new Github();

        // eslint-disable-next-line no-underscore-dangle
        this.breaker = new Breaker(this._githubCommand.bind(this), {
            retry: config.retry,
            breaker: config.breaker
        });
    }
    /**
    * Format the scmUrl for the specific source control
    * @method formatScmUrl
    * @param {String}    scmUrl        Scm Url to format properly
    */
    formatScmUrl(scmUrl) {
        let result = scmUrl;
        const branchName = getInfo(result).branch;

        // Do not convert branch name to lowercase
        result = result.split('#')[0].toLowerCase().concat(`#${branchName}`);

        return result;
    }

    /**
    * Get a users permissions on a repository
    * @method _getPermissions
    * @param  {Object}   config            Configuration
    * @param  {String}   config.scmUrl     The scmUrl to get permissions on
    * @param  {String}   config.token      The token used to authenticate to the SCM
    * @return {Promise}
    */
    _getPermissions(config) {
        const scmInfo = getInfo(config.scmUrl);

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'get',
                token: config.token,
                params: {
                    user: scmInfo.user,
                    repo: scmInfo.repo
                }
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve(data.permissions);
            });
        });
    }

    /**
     * Get a commit sha for a specific repo#branch
     * @method getCommitSha
     * @param  {Object}   config            Configuration
     * @param  {String}   config.scmUrl     The scmUrl to get commit sha of
     * @param  {String}   config.token      The token used to authenticate to the SCM
     * @return {Promise}
     */
    _getCommitSha(config) {
        const scmInfo = getInfo(config.scmUrl);

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'getBranch',
                token: config.token,
                params: scmInfo
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve(data.commit.sha);
            });
        });
    }

    /**
    * Update the commit status for a given repo and sha
    * @method updateCommitStatus
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUrl       The scmUrl to get permissions on
    * @param  {String}   config.sha          The sha to apply the status to
    * @param  {String}   config.buildStatus  The build status used for figuring out the commit status to set
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   [config.url]        Optional target url
    * @return {Promise}
    */
    _updateCommitStatus(config) {
        const scmInfo = getInfo(config.scmUrl);

        const params = {
            user: scmInfo.user,
            repo: scmInfo.repo,
            sha: config.sha,
            state: STATE_MAP[config.buildStatus] || 'failure',
            context: 'screwdriver'
        };

        if (config.url) {
            params.target_url = config.url;
        }

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'createStatus',
                token: config.token,
                params
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve(data);
            });
        });
    }

    /**
    * Fetch content of a file from github
    * @method getFile
    * @param  {Object}   config              Configuration
    * @param  {String}   config.scmUrl       The scmUrl to get permissions on
    * @param  {String}   config.path         The file in the repo to fetch
    * @param  {String}   config.token        The token used to authenticate to the SCM
    * @param  {String}   config.ref          The reference to the SCM, either branch or sha
    * @return {Promise}
    */
    _getFile(config) {
        const scmInfo = getInfo(config.scmUrl);

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'getContent',
                token: config.token,
                params: {
                    user: scmInfo.user,
                    repo: scmInfo.repo,
                    path: config.path,
                    ref: config.ref || scmInfo.branch
                }
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                if (data.type !== 'file') {
                    return reject(new Error(`Path (${config.path}) does not point to file`));
                }

                const contents = new Buffer(data.content, data.encoding).toString();

                return resolve(contents);
            });
        });
    }

    /**
    * Retrieve stats for the executor
    * @method stats
    * @param  {Response} Object          Object containing stats for the executor
    */
    stats() {
        return {
            requests: {
                total: this.breaker.getTotalRequests(),
                timeouts: this.breaker.getTimeouts(),
                success: this.breaker.getSuccessfulRequests(),
                failure: this.breaker.getFailedRequests(),
                concurrent: this.breaker.getConcurrentRequests(),
                averageTime: this.breaker.getAverageRequestTime()
            },
            breaker: {
                isClosed: this.breaker.isClosed()
            }
        };
    }

    /**
     * Return a unique identifier for the scmUrl
     * @method getId
     * @param {Object}    config        Configuration
     * @param {String}    config.scmUrl The scmUrl to generate ID
     * @param {String}    config.token  The token used to authenticate to the SCM
     * @return {Promise}
     */
    getId(config) {
        const scmInfo = getInfo(config.scmUrl);

        return new Promise((resolve, reject) => {
            this.breaker.runCommand({
                action: 'get',
                token: config.token,
                params: {
                    user: scmInfo.user,
                    repo: scmInfo.repo
                }
            }, (error, data) => {
                if (error) {
                    return reject(error);
                }

                return resolve(`${scmInfo.host}:${data.id}:${scmInfo.branch}`);
            });
        });
    }
}

module.exports = GithubScm;
