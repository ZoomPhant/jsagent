/**
* Manage tasks got from servers
*/
const _ = require('lodash')
const moment = require('moment')
const config = require('libs/config')

module.exports = (accountId) => {
    const logger = require('libs/logger').get('tasks-' + accountId)
    
    
    /**
    * Task state
    *                                           <time to run>
    *     create / update ----> schedules ------------------------>pendings
    *                              ^                                  |
    *                              |      <response or timeout>       |
    *                               ----------------------------------
    * 
    * A task could have following sub-tasks
    *   1. discover sub-task. Optiona. Shall be executed before the below task, and may have 
    *      different scheduling intervals
    *   2. collect sub-task. Must have. for JS collector, shall always be interval-based
    * 
    * When scheduling, we would always schedule on the who task, so if there's discover task
    * and 
    *   1. if it is has not been executed yet
    *   2. if it has a periodic requirement and need be re-run again
    * we would
    *   1. first schedule the discover task to worker
    *   2. when worker done with result, we schedule the collect task
    * 
    * Only when the collect task been done will we remove the task from pending state
    */
    const state = {
        taskVersion: '',
        
        /** Current tasks meta info, saved in memory, mapping of MonitorTask */
        tasks: {},
        
        taskStatus: {},
        
        /** map resource ID to resource */
        resources: {},
        
        /** 
        * map script ID to collect script
        * {
        *    id: scriptId,
        *    dataType: xxx,     // like collect-json, collect-linemetrics
        *    scriptType: xxx,   // like javascript, groovy,
        *    interval: secheduling interval in MS,
        *    script: script body
        * }
        */
        collectScripts: {},
        
        
        /** 
        * map script ID to discover scripts 
        * {
        *    id: scriptId,
        *    dataType: xxx,     // like collect-json, collect-linemetrics
        *    scriptType: xxx,   // like javascript, groovy,
        *    interval: secheduling interval in MS,
        *    script: script body
        * }
        */
        discoverScripts: {},
        
        /**
        * Map task id to discover results. If the task has discover sub-task, we shall cache
        * the discover result here
        * {
        *    id: scriptId,
        *    scheduleAt: xxx, // the time schedule the discover sub-task to get the result
        *    status: 'success' | 'failure', // last execution status
        *    result: {...}    // cached sd results, will be passed to collect script
        * }
        */
        discovered: {},
    }
    
    const getAccount = () => {
        return accountId;
    }
    
    /**
    * Sync tasks info from server
    */
    const update = feed => {
        // 0. we update scripts & resources first, which will be used by workers to execute tasks
        //    Those are keyed with 
        //        resource-<version>-<id>
        //        script-<version>-<id>
        state.resources = {}
        for (key in feed.resources) {
            state.resources[key] = feed.resources[key]
        }
        
        state.collectScripts = {}
        state.discoverScripts = {}
        for (key in feed.scripts) {
            const script = feed.scripts[key]
            
            state.collectScripts[key] = {
                id: key,
                dataType: script.collectDataType,
                scriptType: script.collectScriptType,
                interval: script.collectInterval,
                script: script.collectScript
            }
            
            if (script.sdScript) {
                state.discoverScripts[key] = {
                    id: key,
                    dataType: script.sdDataType,
                    scriptType: script.sdScriptType,
                    interval: script.sdInterval,
                    script: script.sdScript
                }
            }
        }
        
        state.tasks = {};
        
        // If there's any task is new or need update, we just do the reschedule
        for (key in feed.taskInstances) {
            const task = feed.taskInstances[key];
            if (!task) {
                continue;
            }
            
            /**
            * JS collector not support one time task ...
            *   frequency == 0: one-time background task, not supported by JS collector for now
            *   frequency >= 0x7fffffff: means the task is server scheduled
            */
            const frequency = Number(task.frequency)
            if (frequency <= 0) {
                logger.warn(task, "Ignore task %s (%s) for script %s with zero or negative frequency!", task.name, key, task.scriptId)
                continue
            }
            else if(frequency >= 0x7fffffff) {
                logger.info(task, "Task %s (%s) for script %s is scheduled by server!", task.name, key, task.scriptId)
            }
            else {
                logger.info('Found task %s (%s) for script %s with frequency %s ...', task.name, key, task.scriptId, task.frequency)
            }
            
            state.tasks[key] = task; // update or create the task
        }
    }
    
    const getVersion = () => state.taskVersion
    
    const updateVersion = version => state.taskVersion = version
    
    const getScript = (scriptId, collecting) => {
        if(collecting) {
            return state.collectScripts[scriptId]?.script
        }
        else {
            return state.discoverScripts[scriptId]?.script
        }
    }
    
    /**
    * Set task execution status
    * @param taskId
    * @param type  - discover or collect
    * @param info  - status info object
    */
    const setTaskStatus = (taskId, type, info) => {
        const status = state.taskStatus[taskId] || {};
        
        status[type] = {
            ... info,
            moment: moment(),
        };
        
        state.taskStatus[taskId] = status;
    }
    
    const getTaskStatus = taskId => {
        return state.taskStatus[taskId]
    }
    
    const getStatusDesc = taskId => {
        const status = state.taskStatus[taskId];
        if(!status) {
            return "Task has not been executed yet.";
        }
        
        let desc = ''
        if(status.discover) {
            /**
            * an object like
            * {
            *     moment: a moment object for last time
            *     success: true or false for last execution success,
            *     result: array of discovered objects, show in task detail, only valid if success is true
            *     message: error message, only valid if success is false
            * }
            */
            
            const info = status.discover;
            if(info.success) {
                desc += "Task discovering finished " + info.moment.fromNow() + ". "
            }
            else {
                desc += "Task discovering failed " + info.moment.fromNow() + ". "
            }
        }
        
        if(status.collect) {
            /**
            * an object like
            * {
            *     moment: moment for last execution
            *     success: true or false
            *     result: execution result for last time, show in task detail
            *     message: error message if any
            * }
            */
            const info = status.collect;
            if(info.success) {
                desc += "Task execution finished " + info.moment.fromNow();
            }
            else {
                desc += "Task execution failed " + info.moment.fromNow();
            }
        }
        
        return desc
    }
    
    const getResource = resourceId => state.resources[resourceId]
    
    const setTaskDiscovered = (taskId, discovered) => {
        state.discovered[taskId] = discovered
    }
    
    const getTaskDiscovered = taskId => state.discovered[taskId]
    
    const getTask = taskId => state.tasks[taskId]
    
    const getAllTasks = () => {
        return Object.values(state.tasks)
    }
    
    const getScriptParams = (taskId, scriptId) => {
        const task = state.tasks[taskId]
        if(!task) {
            return {}
        }
        
        const resource = state.resources[task.resourceId];
        if(!resource) {
            return {}
        }
        
        return resource.scriptParams[scriptId] || {}
    }
    
    const getTaskEnvirons = (taskId) => {
        const task = state.tasks[taskId]
        if(!task) {
            return {}
        }
        
        return {
            accountId: task.accountId,
            taskId: task.id,
            taskVersion: state.taskVersion,
            resourceId: task.resourceId,
            scriptId: task.scriptId,
        }
    }
    
    const getTaskLabels = (taskId) => {
        const task = state.tasks[taskId]
        if(!task) {
            return {}
        }
        
        const resource = state.resources[task.resourceId]
        
        return {
            "_resourceName": resource.name,
            "_resource": task.resourceId,
            "_script": task.scriptId,
            "_agent": config.id,
            "_account": task.accountId,
            "_instance": resource.mpiId,
            "_product": resource.mpId,
        }
    }
    
    return {
        update, getAccount, getVersion, updateVersion, getScript, getResource, getTask, getAllTasks, setTaskDiscovered, getTaskDiscovered, getScriptParams, getTaskEnvirons, getTaskLabels, getStatusDesc, setTaskStatus, getTaskStatus
    }
}
