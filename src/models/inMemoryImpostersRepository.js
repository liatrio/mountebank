'use strict';

const { default: stringify } = require('safe-stable-stringify');
const helpers = require('../util/helpers.js'),
    errors = require('../util/errors.js');

/**
 * An abstraction for loading imposters from in-memory
 * @module
 */

function repeatsFor (response) {
    return response.repeat || 1;
}

function repeatTransform (responses) {
    const result = [];
    let response, repeats;

    for (let i = 0; i < responses.length; i += 1) {
        response = responses[i];
        repeats = repeatsFor(response);
        for (let j = 0; j < repeats; j += 1) {
            result.push(response);
        }
    }
    return result;
}

function createResponse (responseConfig, stubIndexFn) {
    const cloned = helpers.clone(responseConfig || { is: {} });

    cloned.stubIndex = stubIndexFn ? stubIndexFn : () => Promise.resolve(0);

    return cloned;
}

function wrap (stub = {}) {
    const cloned = helpers.clone(stub);
    cloned.responseOrder = cloned.responseOrder || [];
    cloned.nextResponseIndex = cloned.nextResponseIndex || 0;

    /**
     * Adds a new response to the stub (e.g. during proxying)
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} response - the response to add
     * @returns {Object} - the promise
     */

    cloned.resetNextIndex = (index = 0) => {
        if(index < 0) {
            index = 0;
        } else if(index >= cloned.responseOrder.length) {
            index = cloned.responseOrder.length - 1;
        }

        cloned.nextResponseIndex = index;
    }

    const findResponse = (response) => {
        const stringifiedResponse = stringify(response);

        for (var index = 0; index < cloned.responses.length; index++) {
            const storedResponse = stringify(cloned.responses[index]);

            if(storedResponse === stringifiedResponse) {
                return index;
            }
        }

        return -1;
    }

    cloned.addResponse = async response => {
        cloned.responses = cloned.responses || [];

        let index = findResponse(response);

        if(index === -1) {
            cloned.responses.push(response);
            index = cloned.responses.length - 1;
        }
        
        cloned.responseOrder.push(index);

        return response;
    };

    /**
     * Selects the next response from the stub, including repeat behavior and circling back to the beginning
     * @memberOf module:models/inMemoryImpostersRepository#
     * @returns {Object} - the response
     * @returns {Object} - the promise
     */
    cloned.nextResponse = async () => {
        if(cloned.responseOrder.length <= 0) {
            return createResponse();
        }

        let response = cloned.responses[cloned.responseOrder[cloned.nextResponseIndex]];

        cloned.nextResponseIndex += 1;

        if(cloned.nextResponseIndex >= cloned.responseOrder.length) {
            cloned.nextResponseIndex = 0;
        }

        return createResponse(response, cloned.stubIndex);
    };

    /**
     * Records a match for debugging purposes
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} request - the request
     * @param {Object} response - the response
     * @param {Object} responseConfig - the config that generated the response
     * @param {Number} processingTime - the time to match the predicate and generate the full response
     * @returns {Object} - the promise
     */
    cloned.recordMatch = async (request, response, responseConfig, processingTime) => {
        cloned.matches = cloned.matches || [];
        cloned.matches.push({
            timestamp: new Date().toJSON(),
            request,
            response,
            responseConfig,
            processingTime
        });
    };

    const responses = cloned.responses || [];
    cloned.responses = [];

    responses.forEach(async response => {
        await cloned.addResponse(response);
    });

    return cloned;
}

/**
 * Creates the stubs repository for a single imposter
 * @returns {Object}
 */
function createStubsRepository () {
    const stubs = [];
    const responses = [];
    let requests = [];

    const addGlobalResponse = function (response) {
        responses.push(response);
    }

    const lookupGlobalResponse = function (index) {
        if(typeof index !== 'Number' || index < 0 || index >= responses.length) {
            return {};
        }

        return responses[index];
    }

    const getGlobalResponseCount = function() {
        return responses.length;
    }

    function reindex () {
        // stubIndex() is used to find the right spot to insert recorded
        // proxy responses. We reindex after every state change
        stubs.forEach((stub, index) => {
            stub.stubIndex = async () => index;
        });
    }

    /**
     * Returns the first stub whose predicates match the filter, or a default one if none match
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Function} filter - the filter function
     * @param {Number} startIndex - the index to to start searching
     * @returns {Object}
     */
    async function first (filter, startIndex = 0) {
        for (let i = startIndex; i < stubs.length; i += 1) {
            if (filter(stubs[i].predicates || [])) {
                return { success: true, stub: stubs[i] };
            }
        }
        return { success: false, stub: wrap() };
    }

    /**
     * Adds a new stub
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} stub - the stub to add
     * @returns {Object} - the promise
     */
    async function add (stub) {
        let wrappedStub = wrap(stub);

        wrappedStub.lookupGlobalResponse = lookupGlobalResponse;
        wrappedStub.addGlobalResponse = addGlobalResponse;
        wrappedStub.getGlobalResponseCount = getGlobalResponseCount;


        stubs.push(wrappedStub);
        reindex();

        return wrappedStub;
    }

    /**
     * Inserts a new stub at the given index
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} stub - the stub to insert
     * @param {Number} index - the index to add the stub at
     * @returns {Object} - the promise
     */
    async function insertAtIndex (stub, index) {
        stubs.splice(index, 0, wrap(stub));
        reindex();
    }

    /**
     * Overwrites the list of stubs with a new list
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} newStubs - the new list of stubs
     * @returns {Object} - the promise
     */
    async function overwriteAll (newStubs) {
        while (stubs.length > 0) {
            stubs.pop();
        }
        newStubs.forEach(stub => add(stub));
        reindex();
    }

    /**
     * Overwrites the stub at the given index with the new stub
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} newStub - the new stub
     * @param {Number} index - the index of the old stuib
     * @returns {Object} - the promise
     */
    async function overwriteAtIndex (newStub, index) {

        if (typeof stubs[index] === 'undefined') {
            throw errors.MissingResourceError(`no stub at index ${index}`);
        }

        stubs[index] = wrap(newStub);
        reindex();
    }

    /**
     * Deletes the stub at the given index
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Number} index - the index of the stub to delete
     * @returns {Object} - the promise
     */
    async function deleteAtIndex (index) {
        if (typeof stubs[index] === 'undefined') {
            throw errors.MissingResourceError(`no stub at index ${index}`);
        }

        stubs.splice(index, 1);
        reindex();
    }

    async function resetResponseAtIndex(index, responseIndex) {
        if (typeof stubs[index] === 'undefined') {
            throw errors.MissingResourceError(`no stub at index ${index}`);
        }

        stubs[index].resetNextIndex(responseIndex);
    }

    /**
     * Returns a JSON-convertible representation
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} options - The formatting options
     * @param {Boolean} options.debug - If true, includes debug information
     * @returns {Object} - the promise resolving to the JSON object
     */
    async function toJSON (options = {}) {
        const cloned = helpers.clone(stubs);

        cloned.forEach(stub => {
            if (!options.debug) {
                delete stub.matches;
            }
        });

        return cloned;
    }

    function isRecordedResponse (response) {
        return response.is && typeof response.is._proxyResponseTime === 'number';
    }

    /**
     * Removes the saved proxy responses
     * @memberOf module:models/inMemoryImpostersRepository#
     * @returns {Object} - Promise
     */
    async function deleteSavedProxyResponses () {
        const allStubs = await toJSON();
        allStubs.forEach(stub => {
            stub.responses = stub.responses.filter(response => !isRecordedResponse(response));
        });
        const nonProxyStubs = allStubs.filter(stub => stub.responses.length > 0);
        await overwriteAll(nonProxyStubs);
    }

    /**
     * Adds a request for the imposter
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} request - the request
     * @returns {Object} - the promise
     */
    async function addRequest (request) {
        const recordedRequest = helpers.clone(request);
        recordedRequest.timestamp = new Date().toJSON();
        requests.push(recordedRequest);
    }

    /**
     * Returns the saved requests for the imposter
     * @memberOf module:models/inMemoryImpostersRepository#
     * @returns {Object} - the promise resolving to the array of requests
     */
    async function loadRequests () {
        return requests;
    }

    /**
     * Clears the saved requests list
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} request - the request
     * @returns {Object} - Promise
     */
    async function deleteSavedRequests () {
        requests = [];
    }

    return {
        count: () => stubs.length,
        first,
        add,
        insertAtIndex,
        overwriteAll,
        overwriteAtIndex,
        deleteAtIndex,
        toJSON,
        deleteSavedProxyResponses,
        addRequest,
        loadRequests,
        deleteSavedRequests,
        resetResponseAtIndex
    };
}

/**
 * Creates the repository
 * @returns {Object}
 */
function create () {
    const imposters = {},
        stubRepos = {};

    /**
     * Adds a new imposter
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Object} imposter - the imposter to add
     * @returns {Object} - the promise
     */
    async function add (imposter) {
        if (!imposter.stubs) {
            imposter.stubs = [];
        }
        imposters[String(imposter.port)] = imposter;

        const promises = (imposter.creationRequest.stubs || []).map(stubsFor(imposter.port).add);
        await Promise.all(promises);
        return imposter;
    }

    /**
     * Gets the imposter by id
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Number} id - the id of the imposter (e.g. the port)
     * @returns {Object} - the imposter
     */
    async function get (id) {
        return imposters[String(id)] || null;
    }

    /**
     * Gets all imposters
     * @memberOf module:models/inMemoryImpostersRepository#
     * @returns {Object} - all imposters keyed by port
     */
    async function all () {
        return Promise.all(Object.keys(imposters).map(get));
    }

    /**
     * Returns whether an imposter at the given id exists or not
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Number} id - the id (e.g. the port)
     * @returns {boolean}
     */
    async function exists (id) {
        return typeof imposters[String(id)] !== 'undefined';
    }

    /**
     * Deletes the imposter at the given id
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Number} id - the id (e.g. the port)
     * @returns {Object} - the deletion promise
     */
    async function del (id) {
        const result = imposters[String(id)] || null;
        delete imposters[String(id)];
        delete stubRepos[String(id)];

        if (result) {
            await result.stop();
        }
        return result;
    }

    /**
     * Deletes all imposters synchronously; used during shutdown
     * @memberOf module:models/inMemoryImpostersRepository#
     */
    function stopAllSync () {
        Object.keys(imposters).forEach(id => {
            imposters[id].stop();
            delete imposters[id];
            delete stubRepos[id];
        });
    }

    /**
     * Deletes all imposters
     * @memberOf module:models/inMemoryImpostersRepository#
     * @returns {Object} - the deletion promise
     */
    async function deleteAll () {
        const ids = Object.keys(imposters),
            promises = ids.map(id => imposters[id].stop());

        ids.forEach(id => {
            delete imposters[id];
            delete stubRepos[id];
        });
        await Promise.all(promises);
    }

    /**
     * Returns the stub repository for the given id
     * @memberOf module:models/inMemoryImpostersRepository#
     * @param {Number} id - the imposter's id
     * @returns {Object} - the stub repository
     */
    function stubsFor (id) {
        // In practice, the stubsFor call occurs before the imposter is actually added...
        if (!stubRepos[String(id)]) {
            stubRepos[String(id)] = createStubsRepository();
        }

        return stubRepos[String(id)];
    }

    /**
     * Called at startup to load saved imposters.
     * Does nothing for in memory repository
     * @memberOf module:models/inMemoryImpostersRepository#
     * @returns {Object} - a promise
     */
    async function loadAll () {
        return Promise.resolve();
    }

    return {
        add,
        get,
        all,
        exists,
        del,
        stopAllSync,
        deleteAll,
        stubsFor,
        createStubsRepository,
        loadAll
    };
}

module.exports = { create };
