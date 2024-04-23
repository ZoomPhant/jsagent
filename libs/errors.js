/**
 * An execution error, with error code and description message
 */
class ExecutionError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

class TimeoutError extends Error {
    constructor(message) {
        super(message);
    }
}

module.exports = {
    ExecutionError,
    TimeoutError,
}