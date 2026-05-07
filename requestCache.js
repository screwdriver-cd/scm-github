'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const REQUEST_CACHE_STORAGE_KEY = Symbol.for('sd.requestCacheStorage');

/**
 * Get the request-local cache storage instance.
 * @returns {AsyncLocalStorage<Map<string, Promise<*>>>} Async local storage for request cache entries
 */
function getRequestCacheStorage() {
    if (!global[REQUEST_CACHE_STORAGE_KEY]) {
        global[REQUEST_CACHE_STORAGE_KEY] = new AsyncLocalStorage();
    }

    return global[REQUEST_CACHE_STORAGE_KEY];
}

/**
 * Build a cache key for the given scope and params.
 * @param {String} scope Cache scope name
 * @param {Object} params Parameters contributing to the cache key
 * @returns {String} Serialized cache key
 */
function getRequestCacheKey(scope, params) {
    return `${scope}:${JSON.stringify(params)}`;
}

/**
 * Resolve a value using the current request-local cache when available.
 * @param {Object} config Cache configuration
 * @param {String} config.scope Cache scope name
 * @param {Object} config.params Parameters contributing to the cache key
 * @param {Function} config.fetcher Function that resolves the uncached value
 * @param {Function} [config.shouldCache] Predicate deciding whether to keep the resolved value cached
 * @returns {Promise<*>} Cached or newly fetched result
 */
function cacheBy({ scope, params, fetcher, shouldCache }) {
    const requestCache = getRequestCacheStorage().getStore() || null;

    if (!requestCache) {
        return fetcher();
    }

    const cacheKey = getRequestCacheKey(scope, params);

    if (requestCache.has(cacheKey)) {
        return requestCache.get(cacheKey);
    }

    requestCache.set(
        cacheKey,
        Promise.resolve()
            .then(fetcher)
            .then(result => {
                if (shouldCache && !shouldCache(result)) {
                    requestCache.delete(cacheKey);
                }

                return result;
            })
            .catch(err => {
                requestCache.delete(cacheKey);
                throw err;
            })
    );

    return requestCache.get(cacheKey);
}

module.exports = {
    cacheBy,
    getRequestCacheStorage
};
