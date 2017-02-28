const MongoSanitize = require('koa-mongo-sanitize')
const {createServer} = require('http')
const Koa = require('koa')
const KoaBody = require('koa-body')
const Logger = require('./lib/logger')
const AccessLog = require('koa-accesslog')

const {createLogger} = require('./lib/logger')

const Login = require('./route/login')
const Config = require('./route/config')
const Initialize = require('./route/initialize')
const Session = require('./route/session')
const Application = require('./route/application')
const Invitation = require('./route/invitation')
const Registration = require('./route/registration')

module.exports = {
    async create({
        port = 8081,
        host = undefined,
        db = 'mongodb://localhost:27017/test',
        secret = require('crypto').randomBytes(32).toString('base64')
    }) {
        const app = new Koa()

        app.context.JWT_SECRET = secret,
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

        app.use( Config.routes )
        app.use( Login.routes )
        app.use( Initialize.routes )
        app.use( Session.routes )
        app.use( Application.routes )
        app.use( Invitation.routes )
        app.use( Registration.routes )

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
