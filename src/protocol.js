/**
* Communication protocol with server
*/
const fs = require('fs')
const config = require('libs/config')
const http = require('libs/http')
const logger = require('libs/logger').get("protocol")

const server = {
    baseURL: '',
    config: {
        params: {
            agentId: config.id,
            token: config.token
        },
        headers: {
            "X-account-id": config.account
        }
    }
}

server.baseURL = config.getBaseURL()

const MOCKING = config.mode === 'mock'

const getTasksMeta = async (requestMp) => {
    if(MOCKING) {
        return {
            taskUpdatedEpoch: '1',
            tasks: []
        }
    }

    if(requestMp) {
        return http.get(server.baseURL + "api/collectors/" + config.id + "/tasksMetaWithMP", server.config)
    }
    else {
        return http.get(server.baseURL + "api/collectors/" + config.id + "/tasksMeta", server.config)
    }
}

const getTasksFeed = async () => {
    if(MOCKING) {
        const resource = require(config.getRoot() + '/scripts/task.json')
        const resourceArr = [{
            id: 'mr1',
            account: 'ca1',
            mpiId: 'mi1',
            mpId: 'mp1',
            name: 'resource 1',
            tags: [],
            attributes: resource.attributes || {},
            scriptParams: {
                "ms1": resource.scriptParams || {
                    "path": "/tmp/test"
                }
            },
        }]
        
        const collectScript = fs.readFileSync(config.getRoot() + '/scripts/collect.js').toString('utf-8');
        const sdScript = fs.readFileSync(config.getRoot() + '/scripts/discover.js').toString('utf-8');
        
        const scriptArr = [{
            id: 'ms1',
            display: 'test script',
            collectDataType: 'json',
            collectScript,
            collectInterval: 60,
            collectScriptType: 'javascript',            
            sdDataType: 'json',
            sdScript,
            sdInterval: 3600,
            sdScriptType: 'javascript'
        }]
        
        const taskArr = [{
            id: 1,
            resourceId: 'mr1',
            accountId: 'ca1',
            scriptId: 'ms1',
            frequency: 60,
            name: 'test instance',
        }]
        
        const resources = resourceArr.reduce((map, res) => {
            map[res.id] = res
            return map
        }, {})

        const scripts = scriptArr.reduce((map, script) => {
            map[script.id] = script
            return map
        }, {})

        const taskInstances = taskArr.reduce((map, task) => {
            map[task.id] = task
            return map
        }, {})

        console.log('Generating task instances', taskInstances)

        return {
            resources, scripts, taskInstances
        }
    }
    
    return http.get(server.baseURL + "api/collectors/" + config.id + "/tasks", server.config)
}

const postPing = async(data) => {
    if(MOCKING) {
        console.log('Try ping with data', data);
        
        return {}
    }
    
    return http.post(server.baseURL + 'api/ping', data, server.config)
}

const mockOKResponse = () => {
    //     export interface AxiosResponse<T = any, D = any>  {
    //         data: T;
    //         status: number;
    //         statusText: string;
    //         headers: RawAxiosResponseHeaders | AxiosResponseHeaders;
    //         config: AxiosRequestConfig<D>;
    //         request?: any;
    //    }
    return {
        data: {},
        status: 200,
        statusText: 'OK',
        headers: [],
        config: {},
    }
}

const reportManualTaskResult = async (result) => {
    if(MOCKING) {
        console.log('Try report manual task result', result)
        return mockOKResponse()
    }

    try {
        await http.post(server.baseURL + 'api/data/manuallyTask', result, server.config)
    }
    catch(err) {
        logger.error({stack: err.stack}, "Cannot report manually task result back to server - " + err.message);
    }
}

/**
 * reportData are following JsonFormationData like
 * {
 *     labels: {...},
 *     dataEntries: [ ... ]
 * }
 *
 * Data entries is like follows
 * {
 *    metricName: 'xxxx',
 *    isNaN: true or false,
 *    value: double value,
 *    epoch: epochTimeInMillis,
 *    labels: {
 *       label1: xxxx,
 *       label2: xxxx
 *    }
 * }
 */
const reportMetrics = async(reportData) => {
    if(MOCKING) {
        console.log('Try report metrics data', reportData)
        return mockOKResponse()
    }

    try {
        await http.post(server.baseURL + 'api/data/add', reportData, server.config)
    }
    catch(err) {
        logger.error({stack: err.stack}, "Cannot report metrics back to server - " + err.message);
    }
}

/**
* Metrics are array of lines, each line is in following format
*  metricName {label1=xxx, label2=xxx, ...} value
*/
const reportMetricLines = async(metrics) => {
    if(MOCKING) {
        console.log('Try report metrics lines', metrics)
        return mockOKResponse()
    }

    try {
        await http.post(server.baseURL + 'api/data/lineMetrics', metrics, server.config)
    }
    catch(err) {
        logger.error({stack: err.stack}, "Cannot report metric lines back to server - " + err.message);
    }
}

/**
* Logs are array of following
* {
*    tags: {
*       label1: xxx,
*       label2: xxx,
*    },
*    logs: [{
*       timestamp: epochInMillis,
*       line: "log line 1"
*    }, {
*       timestamp: epochInMillis,
*       line: "log line 2"
*    },
*    ...
*   ]}
*/
const reportLogs = async(logs) => {
    if(MOCKING) {
        console.log('Try report log lines', logs)
        return mockOKResponse()
    }

   try {
        await http.post(server.baseURL + 'api/data/logs', logs, server.config)
    }
    catch(err) {
        logger.error({stack: err.stack}, "Cannot report logs back to server - " + err.message);
    }
}

/**
* Events are array of following
* {
*    eid: 'xxx',                     // unique ID identify the event
*    timestamp: epochInMillis,       // report timestamp
*    level: 'info',
*    stateful: true or false,
*    catalogs: ['xxx', 'yyy'],
*    tags: {
*       label1: xxx,
*       label2: xxx,
*    },
*    data: '...',
* }
*/
const reportEvents = async(events) => {
    if(MOCKING) {
        console.log('Try report events', events)
        return mockOKResponse()
    }

    try {
        return http.post(server.baseURL + 'api/data/events', events, server.config)
    }
    catch(err) {
        logger.error({stack: err.stack}, "Cannot report events back to server - " + err.message);
    }
}

const reportSDResults = async(result) => {
    if(MOCKING) {
        console.log('Try report SD result', result)
        return mockOKResponse()
    }

    try {
        await http.post(server.baseURL + 'api/data/discovered', result, server.config)
    }
    catch(err) {
        logger.error({stack: err.stack}, "Cannot report SD results back to server - " + err.message);
    }
}

/**
* msg is a JSON object like 
* {
*     epoch: xxx, // milliseconds
*     message: xxx,
*     taskType: xxx,
*     taskId: xxxx,
*     resourceId: xxx,
*     mpiId: xxxx,
*     costTimeInMs: xxxx,
*     agentId: xxx
* }
*/
const reportCollectorErrorMessage = async(msg) => {
    if(typeof msg === 'string') {
        msg = {message: msg}
    }
    
    const data = {
        ...msg,
        epoch: Date.now(),
        agentId: config.id,
    }
    
    if(MOCKING) {
        console.log('Try report collector error', data)
        return mockOKResponse()
    }
    
    return http.post(server.baseURL + '/api/collectors/' + config.id + '/manuallyTask', data, server.config)
}

module.exports = {
    getTasksFeed, getTasksMeta, postPing, reportSDResults, reportMetrics, reportManualTaskResult, reportLogs, reportEvents
}
