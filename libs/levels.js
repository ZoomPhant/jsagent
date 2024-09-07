class EventLevel {
    /**
     * Note: keep consistence with server side definition
     * @type {EventLevel}
     */
    static Cleared = new EventLevel("cleared", -1);
    static Info = new EventLevel("info", 0)
    static Warn = new EventLevel("warn", 1)
    static Error = new EventLevel("error", 2)
    static Fatal = new EventLevel("fatal", 3)

    constructor(name, value) {
        this.name = name
        this.value = value
    }

    toString() {
        return this.name
    }
}

module.exports = EventLevel