const bunyan = require('bunyan');
const config = require('./config')

// created default logger
const defaultLogger = bunyan.createLogger({name: "_default", serializers: bunyan.stdSerializers});
defaultLogger.level(config.logger?.root?.level || "info")

// create moduled logger
const loggers = {

}

/**
 * Get a logger with given name
 */
const get = name => {
    if(!name || name === "") {
        return defaultLogger
    }

    if(loggers.hasOwnProperty(name)) {
        return loggers[name]
    }

    const log = bunyan.createLogger({name: name, serializers: bunyan.stdSerializers});
    const modules = config.logger?.modules || {};
    log.level(modules[name]?.level || defaultLogger.level())
    loggers[name] = log;
    return log;
}

/**
 * Get / set logger's log level with given name.
 */
const level = (name, level) => {
    if(!level) {
        if(!name || name === "") {
            return defaultLogger.level()
        }

        return loggers[name]?.level() || defaultLogger.level();
    }

    if(!name || name === "") {
        defaultLogger.level(level);
    }

    loggers[name]?.level(level)

    return level;
}

/**
 * Remove a logger with given name
 */
const remove = name => {
    if(!name || name === "") {
        defaultLogger.warn("Try removing root logger!");
    }

    delete loggers[name];
}

module.exports = {
    get, level, remove
}
