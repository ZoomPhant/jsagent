/**
* Manage all the scripts this worker handles.
* 
* When receiving a scripts from master, we calc the md5 and try to find the cache
* for compiled scripts. If we found, we would use it, otherwise we compile and cache
* it for future use.
* 
* A script will be removed from cache if it is not used for 30 minutes or so
*/
const vm = require('vm')
const crypto = require('crypto')
const logger = require('libs/logger').get('scripts')
const helper = require('src/format')
const EventLevel = require('libs/levels')
const lighthouse = require('libs/lighthouse')

const md5sum = content => {
    return crypto.createHash('md5').update(content).digest('hex')
}

/**
* Scripts are typed! Each type of scripts, after compiled, shall be a function
* accepting certain # of values
*/
const scripts = {
    /**
    * scriptId to 
    * {
    *    version: xxx,
    *    md5sum: xxx,
    *    script: new VM.Script(...)
    * }
    * 
    * Compiled scripts evaluate to a function taking following params in order
    *    envs - env variales, to access stuff like taskId and others
    *    params - script params
    *    discovered - discovered instances, if any
    */
    collects: {
        
    },
    
    /**
    * scriptId to 
    * {
    *    version: xxx,
    *    md5sum: xxx,
    *    script: new VM.Script(...)
    * }
    * 
    * Compiled scripts evaluate to a function taking following params in order
    *    envs - env variales, to access stuff like taskId and others 
    *    params - script params
    */
    discovers: {
        
    }
}

const compile = (scriptId, version, script, collectScript) => {
    // if we find scriptId, we would
    // 1. check if version is the same
    // 2. if version not the same, we would check md5sum of script
    // 3. if not same, we would update the script
    // return the result
    
    const cache = collectScript ? scripts.collects : scripts.discovers;
    
    logger.debug('Try compile %s scripts %s for version %s with %d bytes', collectScript ? 'collect' : 'discover', scriptId, version, (script||'').length)

    const compiled = cache[scriptId] || {};
    if(compiled.version === version && compiled.size === script.length) {
        return compiled.script;
    }
    
    // version changed! Has md5sum changed?
    const md5 = md5sum(script);
    if(md5 === compiled.md5sum) {
        logger.debug('Script version changed from %s to %s but md5 macthes: %s!', compiled.version, version, md5)
        // not changed, update version and return
        compiled.version = version;
        return compiled.script;
    }
    
    // otherwise, we would have to recompile ...
    compiled.version = version;
    compiled.size = script.length
    compiled.md5sum = md5;
    compiled.script = new vm.Script(script);

    logger.info('Compiled script %s for %s with version %s successfully compiled!', scriptId, collectScript ? 'collecting' : 'discovering', version);
    cache[scriptId] = compiled;

    return compiled.script;
}

const loadCollectScript = (scriptId, version, script) => {
    return compile(scriptId, version, script, true)
}

const loadDiscoverScript = (scriptId, version, script) => {
    return compile(scriptId, version, script, false)
}

/**
 * Payload is a JSON object like
 *   {
 *       script,   // script to execute
 *       environs, // environments variables, like taskId, resourceId, etc.
 *       params,   // params to pass to script
 *       scheduleAt,   // schedule time, default to 0 (one time execution?)
 *       sequence,     // sequence #, default to 0 (not care)
 *       discovered    // discovered instances
 *   }
 * @param type
 * @param task
 * @param chrome - chrome wrapper. If the task requires chrome, it shall call chrome.open to get one and then start using it
 * @param result_handler - handle results like (result, err)
 * @param context -
 * @returns {Promise<void>}
 */
const executeScriptTask = async (type, task, chrome, context = {}) => {
    const {script, environs, resource, params, scheduleAt, sequence, discovered} = task

    // environs contains important info like following
    const {taskId, resourceId, scriptId, taskVersion} = environs

    if(!script) {
        logger.error('Cannot find resource %s or script %s to execute %s task for %s with version %s', resourceId, scriptId, type, taskId, taskVersion)
        throw new Error('Missing script for execution')
    }

    logger.debug(environs, 'Try execute ' + type + ' task with params:', params)

    // otherwise, let's just think we are doing ...
    try {
        const compiled = (type === 'collect') ? loadCollectScript(scriptId, taskVersion, script) : loadDiscoverScript(scriptId, taskVersion, script)
        if(!compiled) {
            new Error('Null script or script not evaluate to function');
        }

        const ret = compiled.runInNewContext({require, chrome, environs, resource, params, discovered, helper, logger, process, lighthouse, EventLevel, ...context})

        // the ret might be a promise, let's resolve it
        return Promise.resolve(ret)
    }
    catch(error) {
        logger.error(error, 'Cannot execute %s task for %s due to %s', type, taskId, error.message)
        throw error;
    }
    finally {
        /**
         * Chrome is an expensive resource, in case user forgot to close the chrome associate with the task, let's do it
         */
        if(chrome) {
            try {
                chrome.close()
            }
            catch(err) {
                logger.error(err, "Error closing chrome instance")
            }
        }
    }
}

module.exports = {loadCollectScript, loadDiscoverScript, executeScriptTask}
