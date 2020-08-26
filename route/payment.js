const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const { IsSchoolSelfOr, School } = require('./school')
const { newId } = require('../lib/id-util')
const { Mailer } = require('./mailer')
const { getBillingDetail } = require('./billing')

route.post('/schools/:id/payments/',
    IsSchoolSelfOr('finance'),
    School,
    async ctx => {
        const { stage } = ctx.school
        if ( !stage.endsWith('.payment') || Number(stage[0]) >= 3 ) {
            ctx.status = 412
            ctx.body = { error: 'incorrect school stage' }
            return
        }

        const {
            images
        } = ctx.request.body

        if (!images) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        const {
            insertedId
        } = await ctx.db.collection('payment').updateOne({
            school: ctx.params.id,
            active: true
        }, {
            $set: {
                type: 'manual',
                school: ctx.params.id,
                created: new Date(),
                round: stage[0],
                images
            },
            $setOnInsert: {
                _id: newId(),
                active: true,
            }
        }, {
            upsert: true
        })

        ctx.status = 200
        ctx.body = { id: insertedId }
   }
)

route.patch('/schools/:id/payments/',
    AccessFilter('finance'),
    School,
    Mailer,
    async ctx => {
        if ( ! ctx.school.stage.endsWith('.paid') ) {
            ctx.status = 412
            ctx.body = { error: 'incorrect school stage' }
            return
        }

        let { confirmOrdinary, confirmEarlybird, reject, reason } = ctx.request.body
        if ([confirmOrdinary, confirmEarlybird, reject].filter($ => $).length !== 1) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        if (confirmOrdinary || confirmEarlybird) {
            // if confirmEarlybird, verify payment's round is ok
            const currentRound = ctx.school.stage[0]
            if (currentRound !== '1' && confirmEarlybird) {
                ctx.status = 412
                ctx.body = { error: `earlybird is not applicable for round ${currentRound}` }
                return
            }

            const pendingBills = await getBillingDetail(ctx, ctx.school._id, currentRound)
            const confirmedBills = pendingBills.map($ => ({
                round: currentRound,
                type: $.type,
                name: $.name,
                price: $.price,
                earlybirdPrice: $.earlybirdPrice,
                amount: $.amount,
                effectiveRule: confirmOrdinary ? 'ordinary'
                             : confirmEarlybird ? 'earlybird'
                             : null,
                effectivePrice: confirmOrdinary ? $.price
                              : confirmEarlybird ? $.earlybirdPrice
                              : null,
                effectiveSum: confirmOrdinary ? $.sum
                            : confirmEarlybird ? $.earlybirdSum
                            : null,
            }))

            await ctx.db.collection('payment').updateOne(
                { school: ctx.params.id, active: true },
                { $set: {
                    active: false,
                    confirmedBills,
                    effectiveRule: confirmOrdinary ? 'ordinary'
                                 : confirmEarlybird ? 'earlybird'
                                 : null
                } }
            )
            if (currentRound === '2') {
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.params.id },
                    { $set: { stage: `1.complete`, 'seat.2pre': ctx.school.seat['2'] } }
                )
            } else {
                await ctx.db.collection('school').updateOne(
                    { _id: ctx.params.id },
                    { $set: { stage: `${ctx.school.stage[0]}.complete`} }
                )
            }
        }

        if (reject) {
            await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { stage: `${ctx.school.stage[0]}.payment`, last_msg: `付款未通过审核：${reason}` } }
            )
        }

        // send mail notification
        let {nickname, account} = ctx.mailConfig
        let mailTemplate

        if (ctx.school.stage[0] === '1') {
            if (confirmOrdinary || confirmEarlybird)
                mailTemplate = ctx.mailConfig.paymentSuccess
            if (reject)
                mailTemplate = ctx.mailConfig.paymentFailure
        }

        if (ctx.school.stage[0] === '2') {
            if (confirmOrdinary || confirmEarlybird)
                mailTemplate = ctx.mailConfig.paymentSuccess2
            if (reject)
                mailTemplate = ctx.mailConfig.paymentFailure2
        }

        if (mailTemplate) {
            let mailHtml = String(mailTemplate).replace(/\{([a-zA-Z][a-zA-Z0-9_-]*)\}/g, (m, key) => {
                switch (key) {
                    case 'school': return ctx.school.school.name
                    case 'reason': return reason
                    default:       return ''
                }
            })

            const {
                success,
                error,
                transportResponse
            } = await ctx.mailer.sendMail({
                to: ctx.school.leader.email,
                subject: '汇文国际模拟联合国大会缴费审核结果',
                html: mailHtml
            })

            if (success) {
                ctx.status = 200
                ctx.body = { message: 'mail scheduled' }
            } else {
                ctx.status = 202
                ctx.body = { message: 'mail not scheduled: ' + (error ? error.toString() : '') + ', ' + (transportResponse || '') }
            }
        } else {
            ctx.status = 202
            ctx.body = { message: 'mail not configured' }
        }
    }
)

route.get('/schools/:id/payments/',
    IsSchoolSelfOr('staff', 'finance'),
    async ctx => {
        let filter = { school: ctx.params.id, active: true }
        if (ctx.query.round)
           filter.round = String(ctx.query.round)
        if (ctx.query.state === 'all')
            delete filter.active

        ctx.status = 200
        ctx.body = await ctx.db.collection('payment').aggregate([
            { $match: filter },
            { $sort: { created: -1 } },
            { $lookup: {
                from: 'school',
                localField: 'school',
                foreignField: '_id',
                as: 'school'
            } },
            { $unwind: '$school' },
            { $project: {
                _id: false,
                id: '$_id',
                time: '$created',
                type: '$type',
                round: { $ifNull: ['$round', '1'] },
                active: { $ifNull: ['$active', false] },
                effectiveRule: { $ifNull: ['$effectiveRule', null] },
                school: {
                    id: '$school._id',
                    name: '$school.school.name'
                },
                images: '$images',
            } }
        ]).toArray()
    }
)

module.exports = {
    routes: route.routes()
}
