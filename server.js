const MongoSanitize = require('koa-mongo-sanitize')
const {createServer} = require('http')
const Koa = require('koa')
const KoaBody = require('koa-body')
const Logger = require('./lib/logger')
const AccessLog = require('koa-accesslog')

const {createLogger} = require('./lib/logger')

module.exports = {
    async create({
        port = 8081,
        host = undefined,
        db = 'mongodb://localhost:27017/test',
        secret = require('crypto').randomBytes(32).toString('base64'),
        postie = null
    }) {
        const app = new Koa()
        app.proxy = true

        app.context.JWT_SECRET = secret
        app.context.POSTIE = postie
        app.context.db = await require('mongodb').MongoClient.connect( db )

        // TODO: inject logging facility

        app.on('error', (err) => {
            console.log(err.stack)
            // TODO: write error to logger
        })

        app.use( AccessLog() )
        app.use( KoaBody({multipart: true}) )
        app.use( MongoSanitize() )

        app.use( createLogger() )

        app.use( require('./route/user').routes )
        app.use( require('./route/config').routes )
        app.use( require('./route/initialize').routes )
        app.use( require('./route/session').routes )
        app.use( require('./route/application').routes )
        app.use( require('./route/invitation').routes )
        app.use( require('./route/registration').routes )
        app.use( require('./route/school').routes )
        app.use( require('./route/exchange').routes )
        app.use( require('./route/hotel').routes )
        app.use( require('./route/reservation').routes )
        app.use( require('./route/billing').routes )
        app.use( require('./route/payment').routes )
        app.use( require('./route/representative').routes )
        app.use( require('./route/export').routes )
        app.use( require('./route/images').routes )
        app.use( require('./route/committee').routes )
        app.use( require('./route/volunteer').routes )
        app.use( require('./route/dais').routes )
        app.use( require('./route/academic-staff-application').routes )

        let server = createServer( app.callback() )
                     .listen(port, host, () => {
                         let {address, port, family} = server.address()
                         if (family === 'IPv6')
                             address = `[${address}]`
                         console.log(`Server listening on: ${address}:${port}`)
                     })

        return server
    }
}
