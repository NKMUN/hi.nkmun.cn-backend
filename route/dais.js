const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { toId } = require('../lib/id-util')
const { Sessions } = require('./session')
const { isPlainObject, get } = require('../lib/property-accessor')
const { Mailer }= require('./mailer')

const Dais = async (ctx, next) => {
    // dais can only get themself
    if (ctx.hasAccessTo('dais') && !(ctx.hasAccessTo('admin') || ctx.hasAccessTo('academic_director'))) {
        if (ctx.params.id !== '~') {
            ctx.status = 403
            ctx.body = { error: 'forbidden' }
            return
        }
    }

    const dais = await ctx.db.collection('dais').findOne(
      ctx.params.id === '~'
        ? { user: ctx.token.user }
        : { _id: ctx.params.id }
    )

    if (!dais) {
        ctx.status = 404
        ctx.body = { error: 'not found' }
        return
    }

    // inject user account state
    const user = await ctx.db.collection('user').findOne(
        { _id: dais.user },
        { hash: false, salt: false, iter: false }
    )

    dais.account_active = Boolean(user && user.active)

    ctx.dais = dais
    if (next) await next()
}

const Route_GetDaisById = async ctx => {
    await Dais(ctx),
    delete ctx.dais.reimbursement
    ctx.status = 200
    ctx.body = toId(ctx.dais)
}

const Route_GetDaisReimbursementById = async ctx => {
    await Dais(ctx)
    ctx.status = 200
    ctx.body = {
        id: ctx.dais._id,
        user: ctx.dais.user,
        role: ctx.dais.role,
        contact: ctx.dais.contact,
        ... ctx.dais.reimbursement
    }
}

route.get('/daises/',
    AccessFilter('admin', 'academic_director'),
    async ctx => {
        const daises = await ctx.db.collection('dais').find(
            {},
            { name: true, user: true, session: true, photoId: true, school: true, contact: true }
        ).toArray()
        ctx.status = 200
        ctx.body = daises.map(toId)
    }
)

route.get('/daises/:id',
    AccessFilter('dais', 'admin', 'finance'),
    Route_GetDaisById
)

route.patch('/daises/:id',
    AccessFilter('dais', 'admin', 'finance'),
    Dais,
    async ctx => {
        const payload = ctx.request.body
        const PERMITTED_FIELDS = [
            'photoId',
            'identification',
            'guardian',
            'guardian_identification',
            'comment',
            'arriveDate',
            'departDate',
            'checkInDate',
            'checkOutDate'
        ]
        for (let key in payload) {
            if (!PERMITTED_FIELDS.includes(key)) {
                ctx.status = 400
                ctx.body = { error: 'not permitted', message: `can not update field: ${key}` }
                return
            }
        }

        await ctx.db.collection('dais').updateOne(
            { _id: ctx.dais._id },
            { $set: payload }
        )

        await Route_GetDaisById(ctx)
    }
)

route.post('/daises/:id',
    AccessFilter('academic_director', 'admin'),
    Dais,
    async ctx => {
        const {
            activate,
            deactivate,
            session
        } = ctx.request.body

        if (!activate && !deactivate && !session) {
            ctx.status = 400
            ctx.body = { error: 'no action' }
            return
        }

        const { _id, user } = ctx.dais

        if (session !== undefined) {
            await Sessions(ctx)
            const targetSession = ctx.sessions.find(sess => sess._id === session)
            if (!targetSession) {
                ctx.status = 400
                ctx.body = { error: 'no such session' }
                return
            }
            await ctx.db.collection('dais').updateOne(
                { _id: _id },
                { $set: {
                    session: targetSession._id,
                    role: '主席-' + targetSession.name,
                    last_modified: new Date()
                } }
            )
            await ctx.db.collection('user').updateOne(
                { _id: user },
                { $set: {
                    access: ['dais'],
                    session: targetSession._id
                } }
            )
            // continue to activate / deactivate, do not end handler
        }

        if (activate) {
            await ctx.db.collection('user').updateOne(
                { _id: user },
                { $set: {
                    active: true,
                    access: ['dais']
                } }
            )
        }

        if (deactivate) {
            await ctx.db.collection('user').updateOne(
                { _id: user },
                { $set: {
                    active: false,
                    access: []
                } }
            )
        }

        await Route_GetDaisById(ctx)
    }
)

route.delete('/daises/:id',
    AccessFilter('academic_director', 'admin'),
    Dais,
    async ctx => {
        await ctx.db.collection('dais').deleteOne({ _id: ctx.dais._id })
        await ctx.db.collection('user').updateOne(
            { _id: ctx.dais.user },
            { $set: { active: false, access: [] } }
        )
        ctx.status = 200
        ctx.body = { message: 'nuked' }
    }
)


route.get('/dais-reimbursements/',
    AccessFilter('admin', 'finance'),
    async ctx => {
        ctx.status = 200
        ctx.body = await ctx.db.collection('dais').aggregate([
            { $match: {
                $or: [
                    { 'reimbursement.inbound.state': {$exists: true} },
                    { 'reimbursement.outbound.state': {$exists: true} },
                ]
            } },
            { $project: {
                '_id':  false,
                'id':   '$_id',
                'role': '$role',
                'user': '$user',
                'name': '$contact.name',
                'inbound_state': '$reimbursement.inbound.state',
                'outbound_state': '$reimbursement.outbound.state',
            } },
            { $sort: { name: 1 } }
        ]).toArray()
    }
)

const REIMBURSEMENT_TRIP_FIELDS = ['inbound', 'outbound']

route.get('/daises/:id/reimbursement',
    AccessFilter('dais', 'admin', 'finance'),
    Route_GetDaisReimbursementById
)

route.patch('/daises/:id/reimbursement',
    AccessFilter('dais', 'admin', 'finance'),
    Dais,
    async ctx => {
        const PERMITTED_FIELDS = [
            'school_region',
            'residence_region',
            'payment_method',
            'bank',
            'alipay',
            ...REIMBURSEMENT_TRIP_FIELDS,
        ]

        const PERMITTED_TRIP_FIELDS = [
            'region',
            'cost',
            'credential',
            'note',
        ]

        const payload = ctx.request.body
        let updateQuery = {}

        // check basic fields
        for (const key in payload) {
            if (!PERMITTED_FIELDS.includes(key)) {
                ctx.status = 400
                ctx.body = { error: 'not permitted', message: `can not update field: ${key}` }
                return
            }
            if (!REIMBURSEMENT_TRIP_FIELDS.includes(key)) {
                updateQuery[`reimbursement.${key}`] = payload[key]
            }
        }

        // update inbound / outbound trip if they are not confirmed / reviewed
        for (const tripKey of REIMBURSEMENT_TRIP_FIELDS) {
            if (tripKey in payload) {
                const tripState = get(ctx.dais, `reimbursement.${tripKey}.state`)
                if (tripState === 'complete' || tripState === 'approved') {
                    // throw if user wants to update after review / payment
                    ctx.status = 400
                    ctx.body = { error: 'INVALID_STATE', message: 'can not change trip detail after approval or payment' }
                    return
                }

                if (!isPlainObject(payload[tripKey])) {
                    ctx.status = 400
                    ctx.body = { error: 'MALFORMED_PAYLOAD', message: 'trip detail should be an object' }
                    return
                }

                for (let key of PERMITTED_TRIP_FIELDS)
                    if (key in payload[tripKey])
                        updateQuery[`reimbursement.${tripKey}.${key}`] = get(payload, `${tripKey}.${key}`)

                updateQuery[`reimbursement.${tripKey}.state`] = 'submitted'
            }
        }

        const ret = await ctx.db.collection('dais').updateOne(
            { _id: ctx.dais._id },
            { $set: { ...updateQuery, last_modified: new Date() } },
            { upsert: true }
        )

        await Route_GetDaisReimbursementById(ctx)
    }
)

async function sendDaisReimbursementEmail(ctx, templateName, dais, trip, tripKey) {
    await Mailer(ctx, async _ => {
        const template = ctx.mailConfig[templateName]
        const mailHtml = String(template).replace(/\{([a-zA-Z][a-zA-Z0-9_-]*)\}/g, (m, key) => {
            switch (key) {
                case 'name':   return dais.contact && dais.contact.name
                case 'region': return (trip.region || []).join('/')
                case 'trip':   return tripKey === 'inbound' ? '来程'
                                    : tripKey === 'outbound' ? '回程'
                                    : '行程'
                default:       return ''
            }
        })

        await ctx.mailer.sendMail({
            to: dais.user,
            subject: '汇文国际中学生模拟联合国大会行程费用报销通知',
            html: mailHtml
        })
    })
}

route.post('/daises/:id/reimbursement/process',
    AccessFilter('admin', 'finance'),
    Dais,
    async ctx => {
        const {
            approve,
            reject,
            review_note = '',
            confirm_payment,
            trip,
        } = ctx.request.body

        let updateQuery = {}

        if (!REIMBURSEMENT_TRIP_FIELDS.includes(trip)) {
            ctx.status = 400
            ctx.body = { error: 'INVALID_TRIP', message: `"${trip}" is not a valid trip` }
            return
        }

        const tripState = get(ctx.dais, `reimbursement.${trip}.state`)
        if (tripState === 'complete') {
            ctx.status = 400
            ctx.body = { error: 'INVALID_STATE', message: 'can not change completed reimbursement' }
            return
        }

        if (approve) {
            updateQuery[`reimbursement.${trip}.state`] = 'approved'
            updateQuery[`reimbursement.${trip}.review_note`] = review_note
        }

        if (reject) {
            updateQuery[`reimbursement.${trip}.state`] = 'rejected'
            updateQuery[`reimbursement.${trip}.review_note`] = review_note
        }

        if (confirm_payment) {
            updateQuery[`reimbursement.${trip}.state`] = 'completed'
        }

        await ctx.db.collection('dais').updateOne(
            { _id: ctx.dais._id },
            { $set: { ...updateQuery, last_modified: new Date() } }
        )

        if (confirm_payment) {
            await sendDaisReimbursementEmail(ctx, 'dais_reimbursement_complete', ctx.dais, ctx.dais.reimbursement[trip], trip)
        }

        await Route_GetDaisReimbursementById(ctx)
    }
)

module.exports = {
    routes: route.routes()
}
