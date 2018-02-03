const ShortId = require('shortid')
module.exports = {
    toId(entry) {
        entry.id = entry._id
        delete entry._id
        return entry
    },
    fromId(entry) {
        entry._id = entry.id
        delete entry.id
        return entry
    },
    newId() {
        return ShortId.generate()
    }
}
