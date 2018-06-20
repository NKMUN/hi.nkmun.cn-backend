const isPlainObject = o => o !== null && o !== undefined && Object.getPrototypeOf(o) === Object.prototype

module.exports = {
    isPlainObject,
    get(o, attr) {
        return attr.split('.').reduce((ret, key) => isPlainObject(ret) ? ret[key] : ret, o)
    }
}