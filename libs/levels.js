const LEVEL_NAMES = ['cleared', 'info', 'warn', 'error', 'critical', 'fatal']
class EventLevel {
    static Cleared = new EventLevel(LEVEL_NAMES[0]);
    static Info = new EventLevel(LEVEL_NAMES[1])
    static Warn = new EventLevel(LEVEL_NAMES[2])
    static Error = new EventLevel(LEVEL_NAMES[3]);

    constructor(name) {
        this.name = name
    }

    toString() {
        return this.name
    }

    ordinal() {
        return LEVEL_NAMES.indexOf(this.name)
    }
}

module.exports = EventLevel