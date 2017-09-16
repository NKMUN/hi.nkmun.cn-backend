const Router = require('koa-router')
const route = new Router()
const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const { Mailer } = require('./mailer')
const { TokenParser } = require('./auth')

route.post('/registration',
    TokenParser,
    LogOp('registration', 'register'),
    async ctx => {
        const { db, token } = ctx
        const schoolId = token.school
        if ( ! schoolId ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let {
            leader,
            login
        } = getPayload(ctx)

        let user = Object.assign(
            {
                user: login.user,
                access: ['leader'],
                school: schoolId,
                reserved: false,
                created: new Date()
            },
            require('../lib/password').derive(login.password)
        )

        let {
            school,
            seat
        } = await db.collection('application').findOne(
            { _id: schoolId },
            { seat: 1, school: 1 }
        )

        try {
            await db.collection('user').updateOne(
                { _id: login.user },
                { $set: user,
                  $currentDate: { lastModified: true } },
                { upsert: true }
            )
            await db.collection('school').insert({
                _id: schoolId,
                school: school,
                leader: leader,
                stage: '1.relinquishment',
                seat: {
                    '1': seat,
                    '2': {}
                },
                created: new Date()
            })
            await db.collection('invitation').updateMany(
                { school: schoolId },
                { $set: { used: new Date() } }
            )

            // surpass payload that contains password
            ctx.log.payload = {
                leader,
                login: { user: login.user }
            }
            ctx.log.school = schoolId
            ctx.status = 200
            ctx.body = { message: 'registered' }
        } catch(e) {
            ctx.status = 409
            ctx.body = { error: 'already registered' }
        }
    }
)

module.exports = {
    routes: route.routes()
}
