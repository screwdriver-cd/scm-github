# Contributing to Screwdriver

Have a look at our guidelines, as well as pointers on where to start making changes, in our official [documentation](http://docs.screwdriver.cd/about/contributing).

## Commit message format

We use [semantic-release](https://www.npmjs.com/package/semantic-release), which requires commit messages to be in this specific format: `<type>(<scope>): <subject>`

* Types:
    * feat (feature)
    * fix (bug fix)
    * docs (documentation)
    * style (formatting, missing semi colons, …)
    * refactor
    * test (when adding missing tests)
    * chore (maintain)
* Scope: anything that specifies the scope of the commit. Can be blank or `*`
* Subject: description of the commit. For **breaking changes** that require major version bump, add `BREAKING CHANGE` to the commit message.

**Examples commit messages:**
* Bug fix: `fix: Remove extra space`
* Breaking change: `feat(scm): Support new scm plugin. BREAKING CHANGE: github no longer works`
