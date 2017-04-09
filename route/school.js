const Router = require('koa-router')
const route = new Router()
const { AccessFilter, TokenParser } = require('./auth')
const getPayload = require('./lib/get-payload')
const { Sessions } = require('./session')
const { Config } = require('./config')
const { toId, newId } = require('../lib/id-util')
const { LogOp } = require('../lib/logger')
const { filterExchange } = require('./exchange')
const escapeForRegexp = require('escape-string-regexp')

async function IsSelfOrAdmin(ctx, next) {
    if ( ! ctx.token )
        await TokenParser(ctx)

    if ( ctx.token.access.indexOf('admin') !== -1 )
        return await next()

    if ( ctx.token.access.indexOf('school') !== -1 && ctx.params.id === ctx.token.school )
        return await next()

    ctx.status = 403
    ctx.body = { error: 'forbidden' }
}

async function School(ctx, next) {
    ctx.school = await ctx.db.collection('school').findOne({ _id: ctx.params.id })
    if ( ! ctx.school ) {
        ctx.status = 404
        ctx.body = { error: 'not found' }
    } else {
        if (next)
            await next()
    }
}

route.get('/schools/',
    AccessFilter('school', 'admin'),
    async ctx => {
        let filter = {}
        if (ctx.query.stage)
            filter.stage = { $eq: ctx.query.stage }

        let projection = {
            _id:   0,
            id:    '$_id',
            name:  '$school.name',
            stage: '$stage'
        }
        if (ctx.query.seat)
            projection.seat = '$seat'

        ctx.status = 200
        ctx.body = await ctx.db.collection('school').aggregate([
            { $match: filter },
            { $project: projection }
        ]).toArray()
    }
)

route.get('/schools/:id',
    IsSelfOrAdmin,
    School,
    async ctx => {
        // add 'exchanges' field
        // return school's ongoing exchange requests
        if ( ctx.school.stage === '1.exchange' ) {
            ctx.school.exchanges = ( await filterExchange(ctx, { from: ctx.school._id }) ).map( toId )
        }

        ctx.status = 200
        ctx.body = toId(ctx.school)
    }
)

route.get('/schools/:id/seat',
    IsSelfOrAdmin,
    School,
    async ctx => {
        ctx.status = 200
        ctx.body = ctx.school.seat
    }
)

route.patch('/schools/:id',
    AccessFilter('admin'),
    School,
    LogOp('school', 'patch'),
    async ctx => {
        const field = ctx.query.field
        if (   !field
            || field[0]==='$'
            || field==='stage'
            || field==='created'
            || field==='id'
            || field==='_id'
        ) {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
            return
        }

        if ( field.startsWith('seat.') ) {
            let stage = ctx.school.stage
            if ( field[5] === stage[0]    // modifies current round
                 && (stage.endsWith('.paid') || stage.endsWith('.complete'))
            ) {
                ctx.status = 412
                ctx.body = { error: 'incorrect stage to make modify seats' }
                return
            }
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { [field]: ctx.request.body } }
            )
            if (matchedCount === 0) {
                ctx.status = 412
                ctx.body = { error: 'invalid stage' }
                return
            }
        } else {
            await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { [field]: ctx.request.body } }
            )
        }

        await School(ctx)
        ctx.status = 200
        ctx.body = ctx.school
    }
)

route.post('/schools/:id/seat',
    IsSelfOrAdmin,
    LogOp('school', 'seat'),
    School,
    Sessions,
    async ctx => {
        const {
            confirmRelinquish,
            confirmExchange,
            confirmPayment,
            allocSecondRound,
            leaderAttend,
            session,
            round,
            amount = 0,
        } = getPayload(ctx)

        let processed = false

        // seat relinquish
        if (session && round && amount) {
            let filter = { _id: ctx.params.id }
            let field = `seat.${round}.${session}`

            if (amount < 0)
                filter[field] = { $gte: -amount }

            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                filter,
                { $inc: { [field]: amount } }
            )

            if ( ! matchedCount ) {
                ctx.status = 410
                ctx.body = { error: 'insufficient seats' }
                return
            }

            processed = true
        }

        // leaderAttend
        if (leaderAttend !== undefined) {
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id },
                { $set: { 'seat.1._leader': leaderAttend ? 0 : 1 } }
            )
            processed = matchedCount === 1
        }

        // confirmRelinquish
        if (confirmRelinquish) {
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id, stage: '1.relinquishment' },
                { $set: { stage: '1.exchange' } }
            )
            processed = matchedCount === 1
        }

        // confirmExchange
        if (confirmExchange) {
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id, stage: '1.exchange' },
                { $set: { stage: '1.reservation' } }
            )
            processed = matchedCount === 1
        }

        // allocSecondRound
        if (allocSecondRound) {
            // only admin can allocate second round seats
            if ( ! await AccessFilter('admin')(ctx) )
                return
            let {
                matchedCount
            } = await ctx.db.collection('school').updateOne(
                { _id: ctx.params.id, stage: '1.complete' },
                { $set: { stage: '2.reservation' } }
            )
            processed = matchedCount === 1
            // TODO: maybe send second round email?
        }

        if (processed) {
            ctx.status = 200
            ctx.body = (await ctx.db.collection('school').findOne(
                { _id: ctx.params.id },
                { _id: 0, seat: 1 }
            )).seat
        } else {
            ctx.status = 400
            ctx.body = { error: 'bad request' }
        }
    }
)

route.delete('/schools/:id',
    AccessFilter('admin'),
    School,
    async ctx => {
        let id = ctx.params.id
        await ctx.db.collection('school').updateOne(
            { _id: { $eq: id } },
            { $set: { stage: 'x.nuking' } }
        )

        // NOTE: payment, billing information are not removed
        await ctx.db.collection('exchange').deleteMany({ 'from.school': { $eq: id } })
        await ctx.db.collection('exchange').deleteMany({ 'to.school': { $eq: id } })
        await ctx.db.collection('invitation').deleteMany({ school: { $eq: id } })
        // TODO: remove registered representatives after information collection is implemented

        // restore reservations
        let reservations = await ctx.db.collection('reservation').find({ school: { $eq: id } }).toArray()
        await ctx.db.collection('reservation').deleteMany({ school: { $eq: id } })
        await Promise.all( reservations.map( $ => ctx.db.collection('hotel').updateOne(
            { _id: $.hotel },
            { $inc: { available: 1 } }
        ) ) )

        await ctx.db.collection('school').deleteOne({ _id: { $eq: id } })

        ctx.status = 200
        ctx.body = { message: 'nuked' }
    }
)

module.exports = {
    routes: route.routes(),
    IsSelfOrAdmin,
    School,
}
