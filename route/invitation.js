const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const getPayload = require('./lib/get-payload')
const { LogOp } = require('../lib/logger')
const ShortId = require('shortid')
const { Mailer } = require('./mailer')
const { sign } = require('jsonwebtoken')
const { newId } = require('../id-util')

route.post('/invitations/',
    AccessFilter('admin'),
    LogOp('invitation', 'create'),
    Mailer,
    async ctx => {
        const { school } = getPayload(ctx)
        let application = await ctx.db.collection('application').findOne({ _id: school })

        let invitationCode = ShortId.generate()

        ctx.log.school = school
        ctx.log.invitation = invitationCode

        await ctx.db.collection('invitation').insert({
            _id: newId(),
            school,
            invitation: invitationCode,
            invited: new Date(),
            used: false
        })

        let {nickname, account, invitation} = ctx.mailConfig
        let mailHtml = String(invitation).replace(/\{([a-zA-Z][a-zA-Z0-9_-]*)\}/g, (m, key) => {
            switch (key) {
                case 'school': return application.school.name
                case 'name':   return application.contact.name
                case 'code':   return invitationCode
                default:       return ''
            }
        })

        try {
            let smtpResult = await ctx.mailer.sendMail({
                from: { name: nickname, address: account },
                to: application.contact.email,
                subject: '汇文国际中学生模拟联合国大会名额名额分配结果',
                html: mailHtml
            })
            ctx.log.smtp = smtpResult

            if (parseInt(smtpResult.response) === 250) {
                await ctx.db.collection('application').updateOne(
                    { _id: school },
                    { $set: { processed: true } }
                )
                ctx.status = 200
                ctx.body   = { message: smtpResult.response }
            } else {
                ctx.status = 429
                ctx.body   = { message: smtpResult.response }
            }
        }catch(e){
            ctx.status = 503
            ctx.body = { error: e.message }
            throw e
        }

    }
)

route.get('/invitations/:code', async ctx => {
    const { code } = ctx.params
    let invitation = await ctx.db.collection('invitation').findOne({
        invitation: code,
        $or: [
            { used: { $exists: false } },
            { used: false }
        ]
    })

    if ( ! invitation ) {
        ctx.status = 410
        ctx.body = { error: 'no such invitation' }
        return
    }

    let {
        school,
        _id
    } = await ctx.db.collection('application').findOne(
        { _id: invitation.school },
        { 'school.name': 1, 'school.englishName': 1, _id: 1 }
    )

    ctx.status = 200
    ctx.body = {
        school: {
            name: school.name,
            englishName: school.englishName
        },
        token: sign({ school: _id }, ctx.JWT_SECRET, { expiresIn: '1 hour' })
    }
})

module.exports = {
    routes: route.routes()
}
