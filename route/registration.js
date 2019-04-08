const Router = require('koa-router')
const route = new Router()
const { TokenParser } = require('./auth')
const { setQuota } = require('./ng-quota')

route.post('/registration',
    TokenParser,
    async ctx => {
        const { db, token } = ctx
        const {
            school: schoolId,
            type
        } = token

        if ( !schoolId || !type ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        let {
            leader,
            login
        } = ctx.request.body

        let user = {
            _id: login.user,
            user: login.user,
            access: type === 'school' ? ['leader'] : ['individual'],
            school: schoolId,
            reserved: false,
            created: new Date(),
            ...require('../lib/password').derive(login.password)
        }

        const {
            identifier,
            school,
            contact,
            identification,
            graduation,
            guardian,
            guardian_identification,
            alt_guardian,
            disclaimer_image,
            seat
        } = await db.collection('application').findOne(
            { _id: schoolId },
            { ac_test: false }
        )

        try {
            await db.collection('user').insert(user)
            await db.collection('school').insert({
                _id: schoolId,
                type,
                identifier,
                application_id: schoolId,
                ...(
                    type === 'individual'
                  ? { representative: {
                        contact,
                        graduation_year: graduation,
                        identification: identification,
                        guardian: guardian,
                        guardian_identification: guardian_identification,
                        alt_guardian: alt_guardian,
                        disclaimer_image: disclaimer_image,
                        comment: ''
                    } }
                  : {}
                ),
                school: school,
                leader: leader,
                stage: type === 'school' ? '1.relinquishment' : '1.reservation',
                seat: {
                    '1': seat || {},
                    '2': {}
                },
                created: new Date()
            })
            await db.collection('invitation').updateMany(
                { school: schoolId },
                { $set: { used: new Date() } }
            )
            await setQuota(ctx, schoolId, seat)

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
